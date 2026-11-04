import { MarkdownView, Notice, Platform, Plugin, TFile, editorInfoField, type TAbstractFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, WordplaySettingTab, type WordplaySettings } from './settings';
import { editorExtension } from './editor';
import { PANEL_VIEW, WordplayPanel } from './panel';
import { Passes } from './passes';
import { Scratchpads } from './scratchpad';
import { Popover, type MenuSection } from './menu';
import { fromStore, toStore, choiceAt, choiceOn, ghostAt, type Item, type StoredFile } from './items';
import { loadItems, passField, setEditMode, setGlobalEditMode } from './state';
import {
  allOriginal, currentChoice, cutWithBang, cycle, itemsOf, pin, setActive, settle, settleAll, targetAt, tidyCut,
  toggleGhost, unghost, unghostAll, type Target,
} from './actions';
import { clearPens, flyAway, fx, inkPens, sound } from './fx';
import { AiError } from './ai';
import { trimSpan } from './text';

interface Data {
  settings: WordplaySettings;
  files: Record<string, StoredFile>;
  scratchpads: Record<string, string>;
  editMode: boolean;
}

const LOCK_IN = 'dangerzone-writing-plugin';

/**
 * Wordplay — an editing playground. After Jason Fried's Write_On: alternative control, not version control.
 *   edit mode     ⌥⌘E. Underlines, ghosts and the passes chip show up; writing mode stays clean
 *   alternatives  select (or just sit in a word), right-click: write your own, or ask the AI
 *   cycling       ⌥←/→ inside a choice swaps them in on the page; a low tone means you're home
 *   explode       ⌫ while cycling, or in the panel, and that option bursts. ⌘Z brings it back
 *   ghost         dim a stretch to read the page without it
 *   scratchpad    stash a bit out of the draft, never out of reach
 *   passes        typos, weak sentences, long ones, tangles, tone, hedges, over-explaining, trims
 */
export default class WordplayPlugin extends Plugin {
  settings: WordplaySettings = DEFAULT_SETTINGS;
  data: Omit<Data, 'settings' | 'editMode'> = { files: {}, scratchpads: {} };
  editMode = false;
  views = new Set<EditorView>();
  scratch = new Scratchpads(this);
  passes = new Passes(this);
  private lastView: MarkdownView | null = null;
  private statusEl!: HTMLElement;
  private saveTimer = 0;
  private refreshQueued = false;

  async onload(): Promise<void> {
    await this.loadAll();
    setGlobalEditMode(this.editMode);
    this.applyFeel();

    this.registerView(PANEL_VIEW, (leaf) => new WordplayPanel(leaf, this));
    this.registerEditorExtension(editorExtension(this));
    this.addSettingTab(new WordplaySettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('wp-status', 'mod-clickable');
    this.statusEl.addEventListener('click', () => this.setEditMode(!this.editMode));
    this.addRibbonIcon('shuffle', 'Wordplay: edit mode', () => this.setEditMode(!this.editMode));
    this.paintStatus();

    this.commands();

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => void this.renamed(file, oldPath)));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (this.data.files[file.path]) { delete this.data.files[file.path]; this.saveSoon(); }
      this.scratch.forget(file.path);
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (Object.values(this.data.scratchpads).includes(file.path)) this.panel()?.scratchChanged(file.path);
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf?.view instanceof MarkdownView) { this.lastView = leaf.view; this.panel()?.noteChanged(); }
      this.queueRefresh();
    }));
    this.registerEvent(this.app.workspace.on('file-open', () => { this.panel()?.noteChanged(); this.queueRefresh(); }));
    this.registerEvent(this.app.workspace.on('css-change', () => inkPens()));
    this.app.workspace.onLayoutReady(() => window.setTimeout(inkPens, 100));

    // Lock In's fuse burns a draft if you stop to fiddle, so edit mode steps out while it's lit
    this.registerInterval(window.setInterval(() => {
      if (this.editMode && this.fuseLit()) {
        this.setEditMode(false, true);
        new Notice("the fuse is lit, so edit mode stepped out. write.", 4000);
      }
    }, 1500));
  }

  onunload(): void {
    window.clearTimeout(this.saveTimer);
    void this.saveAll();
    document.body.removeClass('wordplay-on');
    clearPens();
    this.passes.closeMenu();
  }

  // ---- commands ----

  private commands(): void {
    const withEditor = (id: string, name: string, run: (cm: EditorView) => void, hotkey?: { modifiers: Array<'Mod' | 'Ctrl' | 'Alt' | 'Shift'>; key: string }) => {
      this.addCommand({
        id, name,
        ...(hotkey ? { hotkeys: [hotkey] } : {}),
        checkCallback: (checking) => {
          const cm = this.cm();
          if (!cm) return false;
          if (!checking) run(cm);
          return true;
        },
      });
    };

    this.addCommand({ id: 'toggle-edit-mode', name: 'Toggle edit mode', hotkeys: [{ modifiers: ['Alt', 'Mod'], key: 'E' }], callback: () => this.setEditMode(!this.editMode) });

    withEditor('alternatives', 'Alternatives for selection (write your own)', (cm) => void this.alternatives(cm), { modifiers: ['Ctrl', 'Shift'], key: 'A' });
    withEditor('ai-alternatives', 'AI alternatives for selection', (cm) => {
      const target = targetAt(cm.state);
      if (!target) { new Notice('put the cursor in a word, or select something.'); return; }
      void this.askAiFor(cm, target);
    }, { modifiers: ['Ctrl', 'Shift'], key: 'G' });
    withEditor('ghost', 'Ghost it (or bring it back)', (cm) => {
      this.ensureEditMode();
      if (toggleGhost(cm) === 'nothing') new Notice('select something to ghost.');
    }, { modifiers: ['Ctrl'], key: '/' });
    withEditor('stash', 'Stash in scratchpad', (cm) => void this.stash(cm), { modifiers: ['Ctrl', 'Shift'], key: 'X' });
    withEditor('passes', 'Passes (mark, fix, trim)', (cm) => this.openPasses(cm), { modifiers: ['Ctrl', 'Shift'], key: 'L' });
    withEditor('edit-menu', 'Edit menu here', (cm) => {
      this.ensureEditMode();
      const c = cm.coordsAtPos(cm.state.selection.main.head);
      this.openEditMenu(cm, c ? { x: c.left, y: c.bottom + 6 } : { x: window.innerWidth / 2, y: window.innerHeight / 3 });
    }, { modifiers: ['Ctrl'], key: '.' });

    withEditor('next', 'Next alternative', (cm) => { if (!cycle(cm, 1)) new Notice('no alternatives here.'); });
    withEditor('previous', 'Previous alternative', (cm) => { if (!cycle(cm, -1)) new Notice('no alternatives here.'); });
    withEditor('original', 'Back to the original', (cm) => { const c = currentChoice(cm.state); if (c) setActive(cm, c.id, 0); });
    withEditor('settle', "Settle on what's showing", (cm) => { const c = currentChoice(cm.state); if (c) settle(cm, c.id); else new Notice('no alternatives here.'); });
    withEditor('settle-all', 'Settle every choice in this note', (cm) => { const n = settleAll(cm); new Notice(n ? `settled ${n}. ⌘Z if that was too soon.` : 'nothing to settle.'); });
    withEditor('all-original', 'Put every choice back to its original', (cm) => { const n = allOriginal(cm); new Notice(n ? `${n} back to the original.` : 'everything is already original.'); });
    withEditor('unghost-all', 'Bring back every ghost', (cm) => { const n = unghostAll(cm); if (!n) new Notice('no ghosts here.'); });
    withEditor('stash-below', 'Stash everything below the cursor', (cm) => {
      const line = cm.state.doc.lineAt(cm.state.selection.main.head);
      void this.stashSpan(cm, line.from, cm.state.doc.length);
    });
    withEditor('clear-pass', "Clear a pass's marks", (cm) => this.passes.done(cm));
    this.addCommand({ id: 'open-panel', name: 'Open the alternatives panel', callback: () => void this.openPanel().then((p) => p?.focusList()) });
    this.addCommand({ id: 'open-scratchpad', name: "Open this note's scratchpad", callback: () => void this.openPanel().then((p) => p?.show('scratch')) });
  }

  // ---- edit mode ----

  setEditMode(on: boolean, quiet = false): void {
    if (on && this.fuseLit()) { new Notice("the fuse is lit. write now, play after.", 3500); return; }
    if (on === this.editMode) return;
    this.editMode = on;
    setGlobalEditMode(on);
    if (on) inkPens();
    for (const v of this.views) v.dispatch({ effects: setEditMode.of(on) });
    if (!on) { this.passes.closeMenu(); for (const v of this.views) if (v.state.field(passField, false)) this.passes.done(v); }
    this.paintStatus();
    if (!quiet) new Notice(on ? 'edit mode. play.' : 'back to writing.', 1100);
    this.saveSoon();
  }

  ensureEditMode(): void { if (!this.editMode) this.setEditMode(true, true); }

  private paintStatus(): void {
    document.body.toggleClass('wordplay-on', this.editMode);
    this.statusEl?.setText(this.editMode ? '✎ edit mode' : '');
    this.statusEl?.toggle(this.editMode);
  }

  private fuseLit(): boolean {
    const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, { session?: { done?: boolean; spec?: { fuse?: boolean } } | null }> } }).plugins?.plugins;
    const session = plugins?.[LOCK_IN]?.session;
    return !!(session && !session.done && session.spec?.fuse);
  }

  // ---- the editor we're working in ----

  markdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) { this.lastView = active; return active; }
    if (this.lastView?.file && this.lastView.containerEl.isConnected) return this.lastView;
    return null;
  }

  cm(): EditorView | null {
    const view = this.markdownView();
    if (!view || view.getMode() === 'preview') return null;
    return (view.editor as unknown as { cm?: EditorView }).cm ?? null;
  }

  currentFile(): TFile | null { return this.markdownView()?.file ?? null; }

  pathOf(view: EditorView): string | null { return view.state.field(editorInfoField, false)?.file?.path ?? null; }

  titleOf(view: EditorView): string { return view.state.field(editorInfoField, false)?.file?.basename ?? 'Untitled'; }

  focusEditor(): void {
    const view = this.markdownView();
    if (!view) return;
    this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
    view.editor.focus();
  }

  editorChanged(view: EditorView): void {
    if (view === this.cm()) this.queueRefresh();
  }

  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    window.requestAnimationFrame(() => { this.refreshQueued = false; this.panel()?.refresh(); });
  }

  // ---- the panel ----

  panel(): WordplayPanel | null {
    const view = this.app.workspace.getLeavesOfType(PANEL_VIEW)[0]?.view;
    return view instanceof WordplayPanel ? view : null;
  }

  async openPanel(): Promise<WordplayPanel | null> {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(PANEL_VIEW)[0];
    if (!leaf) {
      const right = ws.getRightLeaf(false);
      if (!right) return null;
      await right.setViewState({ type: PANEL_VIEW, active: false });
      leaf = right;
    }
    await leaf.loadIfDeferred?.();
    await ws.revealLeaf(leaf);
    return leaf.view instanceof WordplayPanel ? leaf.view : null;
  }

  panelIsVisible(): boolean {
    const panel = this.panel();
    return !!panel && panel.containerEl.isShown() && !this.app.workspace.rightSplit.collapsed;
  }

  async alternatives(cm: EditorView): Promise<void> {
    this.ensureEditMode();
    const target = targetAt(cm.state);
    if (!target) { new Notice('put the cursor in a word, or select something.'); return; }
    pin(cm, target);
    const panel = await this.openPanel();
    panel?.focusInput();
  }

  async askAiFor(cm: EditorView, target: Target): Promise<void> {
    this.ensureEditMode();
    if (!target.choice) pin(cm, target);
    const panel = await this.openPanel();
    if (panel) await panel.ask(cm, target);
  }

  openPasses(cm: EditorView): void {
    this.ensureEditMode();
    window.setTimeout(() => this.passes.openMenu(cm), 0);
  }

  // ---- the edit menu (right-click in edit mode) ----

  openEditMenu(cm: EditorView, at: { x: number; y: number }): void {
    const state = cm.state;
    const sel = state.selection.main;
    const items = itemsOf(state);
    const pos = sel.head;
    const sections: MenuSection[] = [];
    const k = (id: string) => this.hotkeyFor(id);

    if (!sel.empty) {
      const span = trimSpan(state.doc.toString(), { from: sel.from, to: sel.to });
      const existing = choiceOn(items, span.from, span.to);
      sections.push({
        items: [
          { label: 'Alternatives for selection', hint: k('alternatives'), run: () => void this.alternatives(cm) },
          { label: 'AI alternatives for selection', hint: k('ai-alternatives'), run: () => { const t = targetAt(cm.state); if (t) void this.askAiFor(cm, t); } },
          { label: 'Ghost it', hint: k('ghost'), run: () => toggleGhost(cm) },
          { label: 'Stash this in the scratchpad', hint: k('stash'), run: () => void this.stash(cm) },
        ],
      });
      sections.push({ items: [{ label: 'Run a pass on this…', hint: k('passes'), run: () => this.openPasses(cm) }] });
      if (existing && existing.options.length > 1) sections[0].note = `${existing.options.length - 1} alternatives here already`;
    } else {
      const choice = choiceAt(items, pos);
      const ghost = ghostAt(items, pos);
      const mark = state.field(passField, false)?.marks.find((m) => pos >= m.from && pos <= m.to);
      if (choice && choice.options.length > 1) {
        const [prev, next] = this.cycleHint().split(' ');
        sections.push({
          title: `${choice.options.length - 1} alternative${choice.options.length === 2 ? '' : 's'}`,
          items: [
            { label: 'Next alternative', hint: next, run: () => cycle(cm, 1) },
            { label: 'Previous alternative', hint: prev, run: () => cycle(cm, -1) },
            { label: 'Show them all', run: () => void this.openPanel().then((p) => p?.focusList()) },
            { label: 'More AI ideas', hint: k('ai-alternatives'), run: () => void this.askAiFor(cm, { from: choice.from, to: choice.to, unit: choice.unit, choice }) },
            { label: 'Back to the original', disabled: choice.active === 0, run: () => setActive(cm, choice.id, 0) },
            { label: "Settle on this one", run: () => settle(cm, choice.id) },
          ],
        });
      } else if (choice) {
        sections.push({ items: [
          { label: 'Write an alternative', hint: k('alternatives'), run: () => void this.alternatives(cm) },
          { label: 'AI alternatives', hint: k('ai-alternatives'), run: () => void this.askAiFor(cm, { from: choice.from, to: choice.to, unit: choice.unit, choice }) },
        ] });
      }
      if (ghost) {
        sections.push({
          title: 'Ghost',
          items: [
            { label: 'Bring it back', hint: k('ghost'), run: () => unghost(cm, ghost.id) },
            { label: 'Cut it', run: () => cutWithBang(cm, ghost.from, ghost.to) },
            { label: 'Stash it in the scratchpad', hint: k('stash'), run: () => void this.stashSpan(cm, ghost.from, ghost.to) },
          ],
        });
      }
      if (mark) {
        sections.push({ title: state.field(passField, false)?.label, note: mark.why, items: [
          { label: mark.type === 'cut' ? (mark.kept ? 'Cut it after all' : 'Keep it') : 'What can I do?', run: () => this.passes.clickMark(cm, mark) },
        ] });
      }
    }
    if (!sections.length) return;
    new Popover(sections, () => cm.focus()).showAt(at.x, at.y);
  }

  /** the key for one of our commands, as you'd press it (your own binding if you changed it) */
  hotkeyFor(id: string): string {
    const mgr = (this.app as unknown as { hotkeyManager?: { customKeys?: Record<string, Array<{ modifiers: string[]; key: string }>>; getDefaultHotkeys?: (id: string) => Array<{ modifiers: string[]; key: string }> | undefined } }).hotkeyManager;
    const full = `${this.manifest.id}:${id}`;
    const keys = mgr?.customKeys?.[full] ?? mgr?.getDefaultHotkeys?.(full) ?? [];
    const first = keys[0];
    if (!first) return '';
    const mac = Platform.isMacOS;
    const mod = (m: string) => (mac ? ({ Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' } as Record<string, string>)[m] ?? m : `${m === 'Mod' ? 'Ctrl' : m}+`);
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta'];
    const mods = [...first.modifiers].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(mod).join('');
    const key = first.key.length === 1 ? first.key.toUpperCase() : first.key.replace('Arrow', '');
    return mods + key;
  }

  cycleHint(): string {
    const mac = Platform.isMacOS;
    const m = { alt: mac ? '⌥' : 'Alt+', 'ctrl-alt': mac ? '⌃⌥' : 'Ctrl+Alt+', ctrl: mac ? '⌃' : 'Ctrl+' }[this.settings.cycleKeys];
    return `${m}← ${m}→`;
  }

  // ---- the scratchpad ----

  async stash(cm: EditorView): Promise<void> {
    this.ensureEditMode();
    const state = cm.state;
    const sel = state.selection.main;
    if (!sel.empty) { await this.stashSpan(cm, sel.from, sel.to); return; }
    const ghost = ghostAt(itemsOf(state), sel.head);
    if (ghost) { await this.stashSpan(cm, ghost.from, ghost.to); return; }
    new Notice('select something to stash.');
  }

  async stashSpan(cm: EditorView, from: number, to: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.pathOf(cm) ?? '');
    if (!(file instanceof TFile)) return;
    const before = cm.state.doc;
    const text = before.sliceString(from, to);
    if (!text.trim()) { new Notice('nothing there to stash.'); return; }
    try {
      await this.scratch.stash(file, text);
    } catch (e) {
      new Notice(`couldn't stash: ${(e as Error).message}`);
      return;
    }
    // the bit is safe in the scratchpad; now it leaves the draft
    let f = from;
    let t = to;
    if (cm.state.doc !== before) {
      const now = cm.state.doc.toString();
      const at = now.indexOf(text, Math.max(0, from - 200));
      if (at < 0) { new Notice('stashed a copy (the note changed, so it stays here too).'); return; }
      f = at; t = at + text.length;
    }
    const doc = cm.state.doc.toString();
    let cut = tidyCut(doc, f, t);
    // a whole paragraph out: don't leave a hole of blank lines behind
    if (doc[cut.from - 1] === '\n' && doc[cut.to] === '\n') cut = { from: cut.from, to: cut.to + 1 };
    flyAway(cm, f, t);
    sound.whoosh();
    cm.dispatch({ changes: { from: cut.from, to: cut.to, insert: '' }, userEvent: 'delete.wordplay.stash' });
    new Notice('stashed in the scratchpad.', 1800);
    this.panel()?.scratchChanged(this.data.scratchpads[file.path] ?? '');
  }

  putBack(text: string): void {
    const cm = this.cm();
    if (!cm) { new Notice('open the note first.'); return; }
    const pos = cm.state.selection.main.head;
    const before = cm.state.sliceDoc(Math.max(0, pos - 1), pos);
    const after = cm.state.sliceDoc(pos, pos + 1);
    const insert = (before && !/\s/.test(before) ? ' ' : '') + text + (after && !/[\s.,;:!?)]/.test(after) ? ' ' : '');
    cm.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, userEvent: 'input.wordplay.putback' });
    this.focusEditor();
  }

  // ---- saving ----

  loadInto(view: EditorView, path: string): void {
    const items = fromStore(this.data.files[path], view.state.doc.toString());
    view.dispatch({ effects: loadItems.of({ path, items }) });
  }

  persist(path: string, items: Item[]): void {
    const stored = toStore(items);
    if (stored) this.data.files[path] = stored;
    else if (this.data.files[path]) delete this.data.files[path];
    else return;
    this.saveSoon();
  }

  private async renamed(file: TAbstractFile, oldPath: string): Promise<void> {
    if (this.data.files[oldPath]) {
      this.data.files[file.path] = this.data.files[oldPath];
      delete this.data.files[oldPath];
      this.saveSoon();
    }
    if (file instanceof TFile) await this.scratch.renamed(file, oldPath);
  }

  private async loadAll(): Promise<void> {
    const raw = ((await this.loadData()) ?? {}) as Partial<Data>;
    const saved = (raw.settings ?? {}) as Partial<WordplaySettings>;
    this.settings = { ...DEFAULT_SETTINGS, ...saved, brains: { ...DEFAULT_SETTINGS.brains, ...(saved.brains ?? {}) }, customPasses: saved.customPasses ?? [] };
    this.data = { files: raw.files ?? {}, scratchpads: raw.scratchpads ?? {} };
    this.editMode = !!raw.editMode;
  }

  saveSoon(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.saveAll(), 600);
  }

  private async saveAll(): Promise<void> {
    await this.saveData({ settings: this.settings, files: this.data.files, scratchpads: this.data.scratchpads, editMode: this.editMode } satisfies Data);
  }

  async saveSettings(): Promise<void> {
    this.applyFeel();
    await this.saveAll();
  }

  private applyFeel(): void {
    fx.sounds = this.settings.sounds;
    fx.explosions = this.settings.explosions;
    fx.volume = this.settings.volume;
    document.body.style.setProperty('--wp-ghost-opacity', String(this.settings.ghostOpacity));
  }

  apiKey(): string | null {
    const id = this.settings.keySecret;
    if (!id) return null;
    try { return this.app.secretStorage?.getSecret(id) ?? null; } catch { return null; }
  }

  complain(e: unknown): void {
    if (e instanceof AiError) new Notice(`${e.message}${e.hint ? `\n${e.hint}` : ''}`, 6000);
    else new Notice(`something went wrong: ${(e as Error)?.message ?? e}`, 6000);
    console.warn('Wordplay:', e);
  }
}
