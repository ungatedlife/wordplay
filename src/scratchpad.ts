/**
 * Every note can have a scratchpad: a note of its own where stashed bits wait, out of the draft
 * but never thrown away. It lives in one folder (Scratchpads/ by default), named after its note,
 * and links back to it.
 *
 *   %% stashed 2026-11-03 22:42 %%
 *   the bit you stashed
 */
import { TFile, moment, normalizePath } from 'obsidian';
import type WordplayPlugin from './main';

export interface Chunk { index: number; start: number; end: number; when: string; text: string }

const MARKER = /^%% stashed ([^%\n]*?) %%[ \t]*$/gm;

export function parseChunks(content: string): Chunk[] {
  const marks: Array<{ at: number; end: number; when: string }> = [];
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(content))) marks.push({ at: m.index, end: m.index + m[0].length, when: m[1].trim() });
  return marks.map((mark, i) => {
    const stop = i + 1 < marks.length ? marks[i + 1].at : content.length;
    const text = content.slice(mark.end, stop).replace(/^\s*\n/, '').replace(/\s+$/, '');
    return { index: i, start: mark.at, end: stop, when: mark.when, text };
  });
}

export class Scratchpads {
  constructor(private plugin: WordplayPlugin) {}

  private get app() { return this.plugin.app; }

  private defaultPath(note: TFile): string {
    const folder = normalizePath(this.plugin.settings.scratchFolder || 'Scratchpads');
    return normalizePath(`${folder}/${note.basename} (scratchpad).md`);
  }

  /** this note's scratchpad, if it has one (or a new one, when asked) */
  async get(note: TFile, create = false): Promise<TFile | null> {
    const known = this.plugin.data.scratchpads[note.path];
    const knownFile = known ? this.app.vault.getAbstractFileByPath(known) : null;
    if (knownFile instanceof TFile) return knownFile;
    const path = this.defaultPath(note);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile && this.belongsTo(existing, note)) { this.remember(note.path, existing.path); return existing; }
    if (!create) return null;

    let target = path;
    for (let n = 2; this.app.vault.getAbstractFileByPath(target); n++) target = path.replace(/\.md$/, ` ${n}.md`);
    const folder = target.slice(0, target.lastIndexOf('/'));
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const link = this.app.metadataCache.fileToLinktext(note, target, true);
    const file = await this.app.vault.create(target, `---\nscratchpad-for: "[[${link}]]"\n---\n`);
    this.remember(note.path, file.path);
    return file;
  }

  private belongsTo(scratch: TFile, note: TFile): boolean {
    const fm = this.app.metadataCache.getFileCache(scratch)?.frontmatter;
    const link = typeof fm?.['scratchpad-for'] === 'string' ? fm['scratchpad-for'].replace(/^\[\[|\]\]$/g, '').split('|')[0] : '';
    if (!link) return true;
    return this.app.metadataCache.getFirstLinkpathDest(link, scratch.path)?.path === note.path;
  }

  private remember(notePath: string, scratchPath: string): void {
    this.plugin.data.scratchpads[notePath] = scratchPath;
    this.plugin.saveSoon();
  }

  async stash(note: TFile, text: string): Promise<TFile> {
    const file = await this.get(note, true);
    if (!file) throw new Error('no scratchpad');
    const stamp = moment().format('YYYY-MM-DD HH:mm');
    await this.app.vault.process(file, (data) => `${data.replace(/\s+$/, '')}\n\n%% stashed ${stamp} %%\n${text.replace(/^\s*\n|\s+$/g, '')}\n`);
    return file;
  }

  async chunks(note: TFile): Promise<{ file: TFile | null; chunks: Chunk[] }> {
    const file = await this.get(note);
    if (!file) return { file: null, chunks: [] };
    return { file, chunks: parseChunks(await this.app.vault.cachedRead(file)) };
  }

  /** take one stashed bit out of the scratchpad (only when you ask) */
  async toss(note: TFile, chunk: Chunk): Promise<void> {
    const file = await this.get(note);
    if (!file) return;
    await this.app.vault.process(file, (data) => {
      const found = parseChunks(data).find((c) => c.when === chunk.when && c.text === chunk.text);
      if (!found) return data;
      return (data.slice(0, found.start).replace(/\s+$/, '') + '\n\n' + data.slice(found.end).replace(/^\s+/, '')).replace(/\s+$/, '') + '\n';
    });
  }

  /** a note was renamed: its scratchpad follows, name and all */
  async renamed(file: TFile, oldPath: string): Promise<void> {
    const map = this.plugin.data.scratchpads;
    for (const [note, scratch] of Object.entries(map)) {
      if (scratch === oldPath) { map[note] = file.path; this.plugin.saveSoon(); }
    }
    const scratchPath = map[oldPath];
    if (!scratchPath) return;
    delete map[oldPath];
    map[file.path] = scratchPath;
    this.plugin.saveSoon();
    const scratch = this.app.vault.getAbstractFileByPath(scratchPath);
    const want = this.defaultPath(file);
    if (scratch instanceof TFile && scratch.path !== want && !this.app.vault.getAbstractFileByPath(want)) {
      const oldBase = oldPath.slice(oldPath.lastIndexOf('/') + 1).replace(/\.md$/, '');
      if (scratch.basename === `${oldBase} (scratchpad)`) {
        await this.app.fileManager.renameFile(scratch, want);
        map[file.path] = want;
        this.plugin.saveSoon();
      }
    }
  }

  forget(notePath: string): void {
    if (this.plugin.data.scratchpads[notePath]) { delete this.plugin.data.scratchpads[notePath]; this.plugin.saveSoon(); }
  }
}
