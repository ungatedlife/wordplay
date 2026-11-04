// A pretend OpenRouter for the sandbox: answers like a model would, without a key or a bill.
import http from 'node:http';

const PORT = Number(process.env.WP_MOCK_PORT ?? 8787);
const DELAY = Number(process.env.WP_MOCK_DELAY ?? 900);

const SWAPS = {
  hard: ['brutal', 'tricky', 'a slog', 'thorny', 'uphill'],
  tension: ['pressure', 'friction', 'uncertainty', 'struggle', 'tough stuff'],
  debates: ['arguments', 'fights', 'standoffs', 'back-and-forths'],
};

function alternatives(user) {
  const m = /⟦([\s\S]*?)⟧/.exec(user);
  const target = m ? m[1] : 'thing';
  const n = Number(/How many: (\d+)/.exec(user)?.[1] ?? 5);
  const steer = /steer for these: (.*)/.exec(user)?.[1];
  const key = target.toLowerCase().replace(/[^a-z]/g, '');
  if (SWAPS[key]) return { options: SWAPS[key].slice(0, n).map((text, i) => ({ text, why: ['plainer', 'sharper', 'warmer', 'odder', 'shorter'][i % 5] })) };
  if (/\s/.test(target.trim())) {
    const words = target.trim().split(/\s+/);
    return { options: [
      { text: words.slice(0, Math.max(3, Math.ceil(words.length / 2))).join(' ').replace(/[,;]$/, '') + '.', why: 'half as long' },
      { text: `Here's the thing: ${target.trim().charAt(0).toLowerCase()}${target.trim().slice(1)}`, why: 'leads in' },
      { text: steer ? `${target.trim()} (${steer})` : target.trim().replace(/\bthe\b/gi, 'that'), why: steer ? 'steered' : 'pointier' },
    ] };
  }
  return { options: ['spark', 'nudge', 'glint', 'hum', 'whisper'].slice(0, n).map((text) => ({ text, why: 'a guess' })) };
}

function pass(user) {
  const sentences = [...user.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
  const items = [];
  if (/Trim the draft/.test(user)) {
    const pct = Number(/by about (\d+)%/.exec(user)?.[1] ?? 10);
    for (const s of sentences) {
      for (const w of ['really ', 'basically ', 'honestly', 'just ', 'all ', 'finally ', 'somewhere']) {
        if (s.text.includes(w)) items.push({ s: s.n, text: w.trim(), why: 'filler' });
      }
      if (pct >= 30 && /^It all depends/.test(s.text)) items.push({ s: s.n, text: s.text, why: 'says it twice' });
    }
  } else if (/typos/.test(user)) {
    for (const s of sentences) {
      if (s.text.includes('teh')) items.push({ s: s.n, text: 'teh', fix: 'the', why: 'typo' });
      if (s.text.includes('possible.')) continue;
      if (/ ,/.test(s.text)) items.push({ s: s.n, text: ' ,', fix: ',', why: 'stray space' });
    }
  } else if (/hedges/.test(user)) {
    for (const s of sentences) for (const w of ['I think', 'basically', 'really', 'just']) if (s.text.includes(w)) items.push({ s: s.n, text: w, why: 'softens without adding' });
  } else {
    for (const s of sentences) if (s.n % 3 === 2) items.push({ s: s.n, why: 'it sags here; the point already landed' });
  }
  return { items };
}

http.createServer((req, res) => {
  const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    send({ data: [
      { id: 'anthropic/claude-haiku-5.5', pricing: { prompt: '0.0000001', completion: '0.0000005' } },
      { id: 'anthropic/claude-sonnet-5.5', pricing: { prompt: '0.000002', completion: '0.00001' } },
    ] });
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const { messages = [], model } = JSON.parse(body || '{}');
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    console.log(`[mock] ${model} ← ${system.slice(0, 40).replace(/\n/g, ' ')}…`);
    const answer = /alternatives/.test(system) ? alternatives(user) : /one pass/.test(system) ? pass(user) : { hi: 'hi, writer.' };
    const content = system ? '```json\n' + JSON.stringify(answer) + '\n```' : 'hi, writer.';
    setTimeout(() => send({ choices: [{ message: { role: 'assistant', content } }] }), DELAY);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock OpenRouter on http://127.0.0.1:${PORT}/v1`));
