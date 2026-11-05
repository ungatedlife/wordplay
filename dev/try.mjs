// A sandbox to play in: a throwaway vault, a separate Obsidian (its own settings, so your real one
// is untouched), a pretend OpenRouter, and this build of Wordplay. `npm run try`.
//   WP_SANDBOX=/some/dir   where the sandbox lives (default: your temp folder)
//   WP_LOOK_LIKE=/path/to/vault/.obsidian   copy that vault's theme, snippets and appearance (read only)
//   --prepare              build the sandbox but don't launch anything
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.WP_SANDBOX ?? path.join(os.tmpdir(), 'wordplay-sandbox');
const vault = path.join(root, 'vault');
const userData = path.join(root, 'obsidian-userdata');
const mockPort = Number(process.env.WP_MOCK_PORT ?? 8787);
const cdpPort = Number(process.env.WP_CDP_PORT ?? 9333);
const realVault = process.env.WP_LOOK_LIKE;

const SAMPLE = `---
status: gestating
---

# Obvious, easy, possible

When you build a product, the hard part is not really the features. It's knowing what needs to be obvious, what should be easy, and what should be possible. I think this is basically the whole job, honestly.

The obvious things are the things people do all the time. They should be right there in front of you, with no hunting. The easy things are the things people do often , but not always. It all depends on your product and your customer, but you should know the difference between always and often. This can be hard, and it will lead to teh most internal debates.

And finally there are the things that are possible. These are things people do rarely. They just need to exist somewhere, so that when someone needs them, they can find them.
`;

const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const copyDir = (from, to) => { if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true }); };

fs.mkdirSync(root, { recursive: true });
write(path.join(vault, 'Obvious, easy, possible.md'), SAMPLE);
const plug = path.join(vault, '.obsidian', 'plugins', 'wordplay');
for (const f of ['main.js', 'manifest.json', 'styles.css']) write(path.join(plug, f), fs.readFileSync(path.join(repo, f)));
const dataPath = path.join(plug, 'data.json');
if (!fs.existsSync(dataPath)) write(dataPath, JSON.stringify({ settings: { baseUrl: `http://127.0.0.1:${mockPort}/v1` }, files: {}, scratchpads: {}, editMode: false }, null, 2));
write(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['wordplay']));
// look like home: your vault's theme, snippets and appearance, copied (read only) if WP_LOOK_LIKE points at it
if (realVault && fs.existsSync(path.join(realVault, 'appearance.json'))) {
  const appearance = JSON.parse(fs.readFileSync(path.join(realVault, 'appearance.json'), 'utf8'));
  if (appearance.cssTheme) copyDir(path.join(realVault, 'themes', appearance.cssTheme), path.join(vault, '.obsidian', 'themes', appearance.cssTheme));
  copyDir(path.join(realVault, 'snippets'), path.join(vault, '.obsidian', 'snippets'));
  write(path.join(vault, '.obsidian', 'appearance.json'), JSON.stringify({ ...appearance, showViewHeader: true }, null, 2));
}
write(path.join(vault, '.obsidian', 'app.json'), JSON.stringify({ livePreview: true, showInlineTitle: true }));
write(path.join(userData, 'obsidian.json'), JSON.stringify({ vaults: { wordplaysandbox01: { path: vault, ts: Date.now(), open: true } } }));
console.log(`sandbox ready: ${vault}`);

if (process.argv.includes('--prepare')) process.exit(0);

const mock = spawn(process.execPath, [path.join(repo, 'dev', 'mock-openrouter.mjs')], { stdio: 'inherit', env: { ...process.env, WP_MOCK_PORT: String(mockPort) } });
const app = spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian', [`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`], { stdio: 'ignore' });
console.log('Obsidian (sandbox) is starting. Turn off Restricted mode if it asks, then ⌥⌘E. Ctrl-C here to stop.');
const stop = () => { mock.kill(); app.kill(); process.exit(0); };
process.on('SIGINT', stop);
app.on('exit', stop);
