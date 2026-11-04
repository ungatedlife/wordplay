/**
 * The panel in the right sidebar. Two tabs:
 *   Alternatives  every option for the spot you're on (word, sentence, paragraph). ↑↓ swaps them in
 *                 on the page, ⌫ explodes one, type to add your own, ?? asks the AI (?? weirder steers it)
 *   Scratchpad    what you've stashed from this note, to put back, drag in, or toss
 */
import { ItemView, Notice, moment, setIcon, type TFile, type WorkspaceLeaf } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import type WordplayPlugin from './main';
import { addAlternatives, explodeOption, itemsOf, pin, setActive, settle, targetAt, type Target } from './actions';
import { choiceById, choiceOn, choices, nearest, type Choice, type Option } from './items';
import { pendingField, setPending } from './state';
import { countBodyWords, frontmatterEnd, UNIT_LABEL, type Unit } from './text';
import { alternatives } from './ai';
import { shake, sound } from './fx';
import type { Chunk } from './scratchpad';

export const PANEL_VIEW = 'wordplay-panel';

interface Busy { path: string; from: number; to: number; text: string }

export class WordplayPanel extends ItemView {
  private tab: 'alts' | 'scratch' = 'alts';
  private unit: Unit | null = null;
  private lastHead = -1;
  private busy: Busy | null = null;
  private scratchFor = '';

  private statsEl!: HTMLElement;
  private tabEls: Record<'alts' | 'scratch', HTMLElement> = {} as Record<'alts' | 'scratch', HTMLElement>;
  private altsEl!: HTMLElement;
  private unitsEl!: HTMLElement;
  private listEl!: HTMLElement;
  private thinkingEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private actionsEl!: HTMLElement;
  private noteEl!: HTMLElement;
  private scratchEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: WordplayPlugin) { super(leaf); }

  getViewType(): string { return PANEL_VIEW; }
  getDisplayText(): string { return 'Alternatives'; }
  getIcon(): string { return 'shuffle'; }

  async onOpen(): Promise<void> {
    this.build();
    this.refresh();
  }

  async onClose(): Promise<void> { this.contentEl.empty(); }

  private build(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass('wp-panel');
    this.statsEl = root.createDiv({ cls: 'wp-stats' });

    const tabs = root.createDiv({ cls: 'wp-tabs' });
    for (const [key, label] of [['alts', 'Alternatives'], ['scratch', 'Scratchpad']] as const) {
      const t = tabs.createEl('button', { cls: 'wp-tab', text: label });
      t.addEventListener('click', () => this.show(key));
      this.tabEls[key] = t;
    }

    this.altsEl = root.createDiv({ cls: 'wp-alts' });
    this.unitsEl = this.altsEl.createDiv({ cls: 'wp-units' });
    this.listEl = this.altsEl.createDiv({ cls: 'wp-list' });
    this.listEl.tabIndex = 0;
    this.listEl.addEventListener('keydown', (e) => this.listKey(e));
    this.listEl.addEventListener('focus', () => this.pinTarget());
    this.thinkingEl = this.altsEl.createDiv({ cls: 'wp-thinking' });

    const wrap = this.altsEl.createDiv({ cls: 'wp-input' });
    this.inputEl = wrap.createEl('textarea', { attr: { rows: '1', placeholder: 'write your own…', spellcheck: 'true' } });
    this.inputEl.addEventListener('keydown', (e) => this.inputKey(e));
    this.inputEl.addEventListener('input', () => this.autosize());
    this.inputEl.addEventListener('focus', () => this.pinTarget());

    this.actionsEl = this.altsEl.createDiv({ cls: 'wp-actions' });
    this.altsEl.createDiv({ cls: 'wp-hint', text: '↑↓ try them · ⌫ explode one · ↵ back to the page · ?? in the box asks the AI (?? weirder steers it)' });
    this.noteEl = this.altsEl.createDiv({ cls: 'wp-in-note' });

    this.scratchEl = root.createDiv({ cls: 'wp-scratch' });
    this.show(this.tab);
  }

  show(tab: 'alts' | 'scratch'): void {
    this.tab = tab;
    for (const key of ['alts', 'scratch'] as const) this.tabEls[key]?.toggleClass('is-active', key === tab);
    this.altsEl?.toggle(tab === 'alts');
    this.scratchEl?.toggle(tab === 'scratch');
    if (tab === 'scratch') void this.renderScratch(true);
    else this.refresh();
  }

  // ---- what we're pointed at ----

  private cm(): EditorView | null { return this.plugin.cm(); }

  private target(cm: EditorView): Target | null {
    const state = cm.state;
    const head = state.selection.main.head;
    if (head !== this.lastHead) {
      // walking into a choice of another size: follow it
      const inner = itemsOf(state).filter((i): i is Choice => i.kind === 'choice' && head >= i.from && head <= i.to);
      if (this.unit && inner.length && !inner.some((c) => c.unit === this.unit)) this.unit = null;
      this.lastHead = head;
    }
    const pending = state.field(pendingField, false);
    const unit = !state.selection.main.empty ? undefined : pending ? undefined : this.unit ?? undefined;
    return targetAt(state, unit);
  }

  private pinTarget(): void {
    const cm = this.cm();
    if (!cm) return;
    const t = this.target(cm);
    if (t && !t.choice && !cm.state.field(pendingField, false)) pin(cm, t);
  }

  // ---- drawing ----

  refresh(): void {
    if (!this.listEl) return;
    const cm = this.cm();
    this.drawStats(cm);
    if (this.tab === 'scratch') { void this.renderScratch(); return; }
    this.drawAlts(cm);
  }

  private drawStats(cm: EditorView | null): void {
    if (!cm) { this.statsEl.setText(''); return; }
    const doc = cm.state.doc.toString();
    const words = countBodyWords(doc);
    const chars = doc.length - frontmatterEnd(doc);
    this.statsEl.setText(`${words.toLocaleString()} words · ${chars.toLocaleString()} chars`);
  }

  private drawAlts(cm: EditorView | null): void {
    this.unitsEl.empty();
    this.listEl.empty();
    this.actionsEl.empty();
    this.noteEl.empty();
    this.thinkingEl.empty();
    if (!cm) {
      this.listEl.createDiv({ cls: 'wp-empty', text: 'Open a note to play.' });
      this.inputEl.disabled = true;
      return;
    }
    this.inputEl.disabled = false;
    const state = cm.state;
    const target = this.target(cm);
    if (!target) {
      this.listEl.createDiv({ cls: 'wp-empty', text: 'Put the cursor in a word, or select something.' });
      this.drawNote(cm);
      return;
    }

    // Word · Sentence · Paragraph
    const units: Unit[] = ['word', 'sentence', 'paragraph'];
    if (target.unit === 'phrase') units.splice(1, 0, 'phrase');
    const head = state.selection.main.head;
    const items = itemsOf(state);
    for (const u of units) {
      const has = items.some((i) => i.kind === 'choice' && i.unit === u && i.options.length > 1 && head >= i.from && head <= i.to);
      const b = this.unitsEl.createEl('button', { cls: 'wp-unit' + (u === target.unit ? ' is-active' : '') + (has ? ' has-alts' : ''), text: UNIT_LABEL[u] });
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        this.unit = u === 'phrase' ? null : u;
        if (state.field(pendingField, false)) cm.dispatch({ effects: setPending.of(null) });
        this.refresh();
      });
    }

    const choice = target.choice;
    const options: Option[] = choice ? choice.options : [{ id: 'original', text: state.sliceDoc(target.from, target.to), source: 'original' }];
    const active = choice ? choice.active : 0;
    options.forEach((o, i) => {
      const row = this.listEl.createDiv({ cls: `wp-row wp-src-${o.source}` + (i === active ? ' is-active' : '') });
      const icon = row.createSpan({ cls: 'wp-row-icon' });
      if (o.source === 'ai') setIcon(icon, 'bot'); else icon.setText('▪');
      const body = row.createDiv({ cls: 'wp-row-body' });
      body.createDiv({ cls: `wp-row-text wp-unit-${target.unit}`, text: o.text });
      if (o.why) body.createDiv({ cls: 'wp-row-why', text: o.why });
      if (i === 0) row.createSpan({ cls: 'wp-row-tag', text: 'original' });
      else if (choice) {
        const x = row.createSpan({ cls: 'wp-row-x', attr: { 'aria-label': 'Explode (⌫)' } });
        setIcon(x, 'x');
        x.addEventListener('mousedown', (e) => e.preventDefault());
        x.addEventListener('click', (e) => { e.stopPropagation(); this.explode(cm, choice, i, row); });
      }
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        if (choice) setActive(cm, choice.id, i);
        this.listEl.focus();
      });
      row.addEventListener('dblclick', () => this.plugin.focusEditor());
      if (i === active) window.requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
    });

    if (this.busy && this.busy.path === this.plugin.pathOf(cm) && this.busy.from <= target.to && this.busy.to >= target.from) {
      this.thinkingEl.createDiv({ cls: 'wp-thinking-label', text: 'thinking' });
      for (let i = 0; i < 3; i++) this.thinkingEl.createDiv({ cls: 'wp-shimmer' });
    }

    const act = (label: string, icon: string, run: () => void, disabled = false, title = '') => {
      const b = this.actionsEl.createEl('button', { cls: 'wp-act' });
      setIcon(b.createSpan(), icon);
      b.createSpan({ text: label });
      if (title) b.setAttr('aria-label', title);
      b.disabled = disabled;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', run);
    };
    act('AI ideas', 'bot', () => void this.ask(cm), !!this.busy, `Ask the ${target.unit === 'word' ? 'quick' : 'smart'} model (or type ?? in the box)`);
    act('original', 'undo-2', () => choice && setActive(cm, choice.id, 0), !choice || choice.active === 0, 'Back to the original');
    act('settle', 'check', () => { if (choice) { settle(cm, choice.id); this.plugin.focusEditor(); } }, !choice || choice.options.length < 2, 'Keep what’s showing; let the rest go');
    this.drawNote(cm);
  }

  /** every choice in the note, to jump around */
  private drawNote(cm: EditorView): void {
    const all = choices(itemsOf(cm.state)).filter((c) => c.options.length > 1);
    if (!all.length) return;
    this.noteEl.createDiv({ cls: 'wp-in-note-title', text: `In this note · ${all.length}` });
    const head = cm.state.selection.main.head;
    for (const c of all) {
      const row = this.noteEl.createDiv({ cls: 'wp-in-note-row' + (head >= c.from && head <= c.to ? ' is-here' : '') });
      row.createSpan({ cls: 'wp-in-note-unit', text: UNIT_LABEL[c.unit].toLowerCase() });
      const text = c.options[c.active].text.replace(/\s+/g, ' ');
      row.createSpan({ cls: `wp-in-note-text wp-src-${c.options[c.active].source}`, text: text.length > 60 ? `${text.slice(0, 60)}…` : text });
      row.createSpan({ cls: 'wp-in-note-count', text: String(c.options.length) });
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        cm.dispatch({ selection: { anchor: c.to }, scrollIntoView: true });
        this.unit = null;
        this.refresh();
      });
    }
  }

  private autosize(): void {
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 240)}px`;
  }

  // ---- keys ----

  private listKey(e: KeyboardEvent): void {
    const cm = this.cm();
    if (!cm) return;
    const target = this.target(cm);
    const choice = target?.choice ?? null;
    // ⌘Z from the panel undoes on the page (an explosion, a swap)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      (e.shiftKey ? redo : undo)(cm);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!choice) { if (e.key === 'ArrowDown') this.inputEl.focus(); return; }
      const next = choice.active + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0 || next >= choice.options.length) { if (next >= choice.options.length) this.inputEl.focus(); return; }
      setActive(cm, choice.id, next);
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      if (!choice) return;
      const row = this.listEl.querySelectorAll<HTMLElement>('.wp-row')[choice.active];
      this.explode(cm, choice, choice.active, row);
    } else if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      this.plugin.focusEditor();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.inputEl.focus();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.inputEl.focus(); // and the letter lands in the box
    }
  }

  private inputKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.plugin.focusEditor();
    } else if (e.key === 'ArrowUp' && this.inputEl.selectionStart === 0 && this.inputEl.selectionEnd === 0) {
      e.preventDefault();
      this.listEl.focus();
    }
  }

  private submit(): void {
    const cm = this.cm();
    const value = this.inputEl.value;
    if (!cm || !value.trim()) return;
    const target = this.target(cm);
    if (!target) { new Notice('put the cursor in a word, or select something.'); return; }
    const trimmed = value.trim();
    if (trimmed.startsWith('??')) {
      this.inputEl.value = '';
      this.autosize();
      void this.ask(cm, target, trimmed.slice(2).trim());
      return;
    }
    const made = addAlternatives(cm, target, [{ text: value.replace(/^\n+|\n+$/g, ''), source: 'human' }], true);
    if ('blocked' in made) { this.blocked(made.blocked); return; }
    if ('nothing' in made) { shake(this.inputEl); sound.nope(); return; }
    this.inputEl.value = '';
    this.autosize();
    this.refresh();
  }

  private blocked(c: Choice): void {
    sound.nope();
    new Notice(`that half-overlaps a ${c.unit} you're already playing with. pick inside it, or around all of it.`, 4000);
  }

  private explode(cm: EditorView, choice: Choice, index: number, row?: HTMLElement | null): void {
    if (index === 0) { shake(row); sound.nope(); return; }
    if (row) {
      const r = row.getBoundingClientRect();
      const ghost = row.cloneNode(true) as HTMLElement;
      ghost.addClass('wp-row-ghost');
      Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
      document.body.appendChild(ghost);
      ghost.animate([
        { transform: 'scale(1)', opacity: 1, filter: 'blur(0)' },
        { transform: 'scale(1.08) rotate(-1.5deg)', opacity: 0.8, filter: 'blur(0.5px)', offset: 0.3 },
        { transform: 'scale(0.6) rotate(3deg)', opacity: 0, filter: 'blur(4px)' },
      ], { duration: 360, easing: 'ease-out', fill: 'forwards' }).onfinish = () => ghost.remove();
    }
    explodeOption(cm, choice.id, index);
    this.listEl.focus();
  }

  // ---- asking the AI ----

  async ask(cm: EditorView, given?: Target, steer?: string): Promise<void> {
    const target = given ?? this.target(cm);
    if (!target) { new Notice('put the cursor in a word, or select something.'); return; }
    if (this.busy) { new Notice('still thinking about the last one…'); return; }
    if (!target.choice) pin(cm, target);
    const path = this.plugin.pathOf(cm);
    const doc = cm.state.doc.toString();
    const text = doc.slice(target.from, target.to);
    this.busy = { path: path ?? '', from: target.from, to: target.to, text };
    this.show('alts');

    const start = frontmatterEnd(doc);
    let from = Math.max(start, target.from - 1500);
    if (from > start) { const nl = doc.indexOf('\n', from); if (nl !== -1 && nl < target.from) from = nl + 1; }
    let to = Math.min(doc.length, target.to + 1200);
    if (to < doc.length) { const nl = doc.lastIndexOf('\n', to); if (nl > target.to) to = nl; }
    const existing = target.choice ? target.choice.options.map((o) => o.text) : [text];

    let ideas: Array<{ text: string; why?: string }> = [];
    try {
      ideas = await alternatives(this.plugin, {
        title: this.plugin.titleOf(cm), before: doc.slice(from, target.from), target: text, after: doc.slice(target.to, to),
        unit: target.unit, existing, steer: steer || undefined,
      }, this.plugin.settings.count);
    } catch (e) {
      this.busy = null;
      this.refresh();
      this.plugin.complain(e);
      return;
    }
    const busy = this.busy;
    this.busy = null;
    if (this.plugin.pathOf(cm) !== path) { new Notice('those ideas were for another note. ask again there.'); this.refresh(); return; }

    // the spot may have moved while it thought
    const state = cm.state;
    const items = itemsOf(state);
    let spot: Target | null = null;
    const byId = target.choice ? choiceById(items, target.choice.id) : null;
    if (byId) spot = { from: byId.from, to: byId.to, unit: byId.unit, choice: byId };
    const pending = state.field(pendingField, false);
    if (!spot && pending) spot = { ...pending, choice: choiceOn(items, pending.from, pending.to) };
    if (!spot && busy) {
      const at = nearest(state.doc.toString(), busy.text, busy.from);
      if (at >= 0) spot = { from: at, to: at + busy.text.length, unit: target.unit, choice: choiceOn(items, at, at + busy.text.length) };
    }
    if (!spot) { new Notice("couldn't find that spot anymore."); this.refresh(); return; }
    const made = addAlternatives(cm, spot, ideas.map((i) => ({ text: i.text, source: 'ai' as const, why: i.why })));
    if ('blocked' in made) this.blocked(made.blocked);
    else if ('nothing' in made || !ideas.length) new Notice('no new ideas that time. try a steer: ?? weirder', 3500);
    else sound.settle();
    // land on the spot so the panel shows it, and hand the arrows over
    const c = 'choice' in made ? made.choice : null;
    if (c) {
      const sel = cm.state.selection.main;
      if (sel.head < c.from || sel.head > c.to) cm.dispatch({ selection: { anchor: c.to } });
    }
    this.refresh();
    if (this.plugin.panelIsVisible()) this.listEl.focus();
  }

  focusInput(): void { this.show('alts'); this.pinTarget(); this.inputEl.focus(); }
  focusList(): void { this.show('alts'); this.listEl.focus(); }

  // ---- the scratchpad tab ----

  async renderScratch(force = false): Promise<void> {
    const file = this.plugin.currentFile();
    const key = file?.path ?? '';
    if (!force && this.tab !== 'scratch') return;
    this.scratchFor = key;
    const el = this.scratchEl;
    if (!file) { el.empty(); el.createDiv({ cls: 'wp-empty', text: 'Open a note to see its scratchpad.' }); return; }
    const { file: pad, chunks } = await this.plugin.scratch.chunks(file);
    if (this.scratchFor !== key) return;
    el.empty();
    const head = el.createDiv({ cls: 'wp-scratch-head' });
    head.createSpan({ text: chunks.length ? `${chunks.length} stashed` : 'nothing stashed yet' });
    if (pad) {
      const open = head.createEl('a', { text: 'open the note', cls: 'wp-scratch-open' });
      open.addEventListener('click', () => void this.app.workspace.getLeaf('split').openFile(pad));
    }
    if (!chunks.length) {
      el.createDiv({ cls: 'wp-empty', text: `Select something you want out of the way but not gone, then ${this.plugin.hotkeyFor('stash') || 'right-click'} → Stash in scratchpad.` });
      return;
    }
    for (const chunk of [...chunks].reverse()) this.drawChunk(el, file, chunk);
  }

  private drawChunk(el: HTMLElement, file: TFile, chunk: Chunk): void {
    const card = el.createDiv({ cls: 'wp-stash' });
    card.draggable = true;
    card.addEventListener('dragstart', (e) => e.dataTransfer?.setData('text/plain', chunk.text));
    const when = moment(chunk.when, 'YYYY-MM-DD HH:mm');
    card.createDiv({ cls: 'wp-stash-when', text: when.isValid() ? when.format('MMM D · h:mma') : chunk.when });
    const text = card.createDiv({ cls: 'wp-stash-text', text: chunk.text });
    text.addEventListener('click', () => text.toggleClass('is-open', !text.hasClass('is-open')));
    const buttons = card.createDiv({ cls: 'wp-stash-buttons' });
    const b = (label: string, run: (btn: HTMLButtonElement) => void) => {
      const btn = buttons.createEl('button', { text: label });
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => run(btn));
    };
    b('put back', () => this.plugin.putBack(chunk.text));
    b('copy', () => { void navigator.clipboard.writeText(chunk.text); new Notice('copied.', 1200); });
    b('toss', (btn) => {
      if (btn.dataset.sure) {
        void this.plugin.scratch.toss(file, chunk).then(() => this.renderScratch(true));
        return;
      }
      btn.dataset.sure = '1';
      btn.setText('sure?');
      btn.addClass('mod-warning');
      window.setTimeout(() => { if (btn.isConnected) { delete btn.dataset.sure; btn.setText('toss'); btn.removeClass('mod-warning'); } }, 2500);
    });
  }

  scratchChanged(path: string): void {
    if (this.tab !== 'scratch') return;
    const file = this.plugin.currentFile();
    if (file && this.plugin.data.scratchpads[file.path] === path) void this.renderScratch(true);
  }

  noteChanged(): void {
    this.unit = null;
    if (this.tab === 'scratch') void this.renderScratch(true);
  }
}
