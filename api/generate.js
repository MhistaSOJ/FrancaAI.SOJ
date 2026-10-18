export const maxDuration = 60;

// ── Settings ────────────────────────────────────────────────
// Firebase web API key (public by design; it is already shipped in the web app).
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyA0Pfm1AHdOs2iRDoTkTpjoqeVolhCH55A';
const escapeRe = o => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ORIGIN_PATTERNS = [
  /^https:\/\/francaai[a-z0-9-]*\.vercel\.app$/,
  /^http:\/\/localhost(:\d+)?$/,
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(o => new RegExp('^' + escapeRe(o) + '$'))
];
const ALLOWED_PROVIDERS = (process.env.ALLOWED_PROVIDERS || 'gemini').split(',').map(s => s.trim());
const MAX_TOKENS_CAP = 8192;
const MAX_PROMPT_CHARS = 40000;
const MAX_IMAGE_CHARS = 4_000_000; // base64 characters
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const RATE_LIMIT = 40;               // requests per user per window (best effort, per server instance)
const RATE_WINDOW_MS = 10 * 60 * 1000;

const tokenCache = new Map(); // idToken -> { uid, exp }
const hits = new Map();       // uid -> [timestamps]

async function verifyUser(idToken) {
  const cached = tokenCache.get(idToken);
  if (cached && cached.exp > Date.now()) return cached.uid;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  const d = await r.json();
  const uid = d?.users?.[0]?.localId;
  if (!uid) return null;
  if (tokenCache.size > 500) tokenCache.clear();
  tokenCache.set(idToken, { uid, exp: Date.now() + 5 * 60 * 1000 });
  return uid;
}

function rateLimited(uid) {
  const now = Date.now();
  const list = (hits.get(uid) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_LIMIT) { hits.set(uid, list); return true; }
  list.push(now); hits.set(uid, list);
  return false;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const originOk = ORIGIN_PATTERNS.some(re => re.test(origin));
  if (originOk) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(originOk ? 200 : 403).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (origin && !originOk) return res.status(403).json({ error: 'Origin not allowed' });

  // Only signed-in FrancaAI users may use the AI service
  const auth = req.headers.authorization || '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!idToken) return res.status(401).json({ error: 'Please sign in again to use AI generation' });
  let uid = null;
  try { uid = await verifyUser(idToken); } catch (e) { return res.status(502).json({ error: 'Could not verify your session. Please try again.' }); }
  if (!uid) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  if (rateLimited(uid)) return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });

  const body = req.body || {};
  const { provider = 'gemini', systemPrompt, userPrompt, image } = body;
  let maxTokens = Number(body.maxTokens) || 4000;
  maxTokens = Math.max(256, Math.min(maxTokens, MAX_TOKENS_CAP));

  if (!ALLOWED_PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Provider not available' });
  if (typeof systemPrompt !== 'string' || typeof userPrompt !== 'string' || !userPrompt.trim()) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (systemPrompt.length > MAX_PROMPT_CHARS || userPrompt.length > MAX_PROMPT_CHARS) {
    return res.status(413).json({ error: 'Request too large' });
  }
  if (image) {
    if (!IMAGE_TYPES.includes(image.mimeType) || typeof image.data !== 'string' || image.data.length > MAX_IMAGE_CHARS) {
      return res.status(400).json({ error: 'Unsupported or oversized image' });
    }
    if (provider !== 'gemini') return res.status(400).json({ error: 'Images are only supported with Gemini' });
  }

  try {
    let result = '';
    let finishReason = '';

    if (provider === 'gemini') {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return res.status(500).json({ error: 'Gemini key not configured' });
      const parts = [];
      if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
      parts.push({ text: userPrompt });
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            // Honour the size the app asks for (it was previously fixed at 4000, which could cut long plans off)
            maxOutputTokens: maxTokens,
            temperature: 0.7,
            responseMimeType: 'application/json',
            // Thinking tokens share the output budget; switching them off keeps long JSON plans from being truncated
            thinkingConfig: { thinkingBudget: 0 }
          }
        })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      result = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      finishReason = d.candidates?.[0]?.finishReason || '';
    } else if (provider === 'groq') {
      const key = process.env.GROQ_API_KEY;
      if (!key) return res.status(500).json({ error: 'Groq key not configured' });
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: maxTokens, temperature: 0.7,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      result = d.choices?.[0]?.message?.content || '';
    } else if (provider === 'claude') {
      const key = process.env.CLAUDE_API_KEY;
      if (!key) return res.status(500).json({ error: 'Claude key not configured' });
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }] })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      result = d.content?.[0]?.text || '';
    } else if (provider === 'openai') {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return res.status(500).json({ error: 'OpenAI key not configured' });
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model: 'gpt-4o', max_tokens: maxTokens, temperature: 0.7,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      result = d.choices?.[0]?.message?.content || '';
    } else {
      return res.status(400).json({ error: 'Unknown provider' });
    }

    return res.status(200).json({ result, finishReason });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
