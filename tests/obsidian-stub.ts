// Just enough of Obsidian for the engine to run under Node in the tests.
import { StateField } from '@codemirror/state';
export const editorInfoField = StateField.define<{ file: { path: string; basename: string } }>({
  create: () => ({ file: { path: 'test.md', basename: 'test' } }),
  update: (v) => v,
});
export class TFile {}
export class Notice { constructor(_m?: string) {} }
export const moment = () => ({ format: () => '2026-11-03 22:42' });
export const normalizePath = (p: string) => p;
export const requestUrl = async () => { throw new Error('no network in tests'); };
export const setIcon = () => {};
export const Platform = { isMacOS: true };
