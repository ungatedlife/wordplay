// Bundles the tests (with a stand-in for Obsidian) and runs them with Node's test runner.
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
await esbuild.build({
  entryPoints: [path.join(here, 'core.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: path.join(here, '.out', 'core.test.mjs'),
  alias: { obsidian: path.join(here, 'obsidian-stub.ts') },
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, ['--test', path.join(here, '.out', 'core.test.mjs')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
