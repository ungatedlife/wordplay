// A tiny Chrome DevTools Protocol client for driving the sandbox Obsidian.
//   node dev/cdp.mjs eval '<js>'          run JS in Obsidian (await works), print the result
//   node dev/cdp.mjs shot out.png         screenshot the window
//   node dev/cdp.mjs keys '<json>'        press keys: [{"key":"ArrowRight","mods":["Alt"]}, {"text":"hello"}]
//   node dev/cdp.mjs click x y [right]    click (or right-click) at a point
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const PORT = process.env.WP_CDP_PORT ?? '9333';

export async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const want = process.env.WP_TARGET; // e.g. "Settings" for a popped-out window
  const page = (want && targets.find((t) => t.type === 'page' && t.title.includes(want)))
    ?? targets.find((t) => t.type === 'page' && t.url.startsWith('app://obsidian.md/index.html')) ?? targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no Obsidian window');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close() };
}

const MOD_BITS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const CODES = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, Delete: 46, Enter: 13, Escape: 27, Tab: 9, ' ': 32 };

export async function press(c, { key, mods = [], code }) {
  const modifiers = mods.reduce((n, m) => n | (MOD_BITS[m] ?? 0), 0);
  const vk = CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const keyCode = code ?? (key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key === '/' ? 'Slash' : key === '.' ? 'Period' : '') : key);
  const text = key.length === 1 && !(modifiers & (2 | 4)) ? key : undefined;
  await c.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: keyCode, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, text });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: keyCode, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const c = await connect();
  try {
    if (cmd === 'eval') {
      const r = await c.send('Runtime.evaluate', { expression: `(async () => { ${args[0].includes('return') ? args[0] : `return (${args[0]})`} })()`, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) console.log('ERROR', JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails, null, 1));
      else console.log(JSON.stringify(r.result?.result?.value, null, 1));
    } else if (cmd === 'shot') {
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(args[0], Buffer.from(r.result.data, 'base64'));
      console.log('saved', args[0]);
    } else if (cmd === 'keys') {
      for (const k of JSON.parse(args[0])) {
        if (k.text) await c.send('Input.insertText', { text: k.text });
        else if (k.wait) await new Promise((r) => setTimeout(r, k.wait));
        else await press(c, k);
        await new Promise((r) => setTimeout(r, 60));
      }
      console.log('pressed');
    } else if (cmd === 'click') {
      const [x, y, which] = args;
      const button = which === 'right' ? 'right' : 'left';
      const base = { x: Number(x), y: Number(y), button, clickCount: 1 };
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y });
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: button === 'right' ? 2 : 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
      console.log('clicked');
    }
  } finally { c.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
