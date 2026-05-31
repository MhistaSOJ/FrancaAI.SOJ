export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { provider, systemPrompt, userPrompt, maxTokens = 4000 } = req.body;

  try {
    let result = '';

    if (provider === 'groq') {
      const key = process.env.GROQ_API_KEY;
      if (!key) return res.status(500).json({ error: 'Groq key not configured' });
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: maxTokens,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          temperature: 0.7
        })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      result = d.choices?.[0]?.message?.content || '';

    } else if (provider === 'gemini') {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return res.status(500).json({ error: 'Gemini key not configured' });
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [{ 
            role: 'user',
            parts: [{ text: userPrompt }] 
          }],
          generationConfig: { 
            maxOutputTokens: 4000,
            temperature: 0.7,
            responseMimeType: "application/json"
          }
        })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      result = d.candidates?.[0]?.content?.parts?.[0]?.text || '';

    } else if (provider === 'claude') {
      const key = process.env.CLAUDE_API_KEY;
      if (!key) return res.status(500).json({ error: 'Claude key not configured' });
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        })
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
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: maxTokens,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          temperature: 0.7
        })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      result = d.choices?.[0]?.message?.content || '';

    } else {
      return res.status(400).json({ error: 'Unknown provider' });
    }

    return res.status(200).json({ result });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
