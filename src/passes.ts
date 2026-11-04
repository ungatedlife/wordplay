/**
 * Passes: an editor reads the whole draft (or the selection) for one thing and marks it.
 * Typos get fixes you can take or leave; the marking passes point; a trim fades the words
 * that could go, and you click any you want to keep. Nothing changes until you say so,
 * and when you do, it's one ⌘Z to take it back.
 */
import { Notice } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { ChangeSpec, Text } from '@codemirror/state';
import type WordplayPlugin from './main';
import { chat, parseJson, AiError, type Brain } from './ai';
import { overlayFor } from './editor';
import { newId, nearest } from './items';
import { passField, patchMark, setCurrentMark, setPass, type MarkType, type PassMark, type PassState } from './state';
import { classify, countBodyWords, countWords, proseBlocks, sentencesIn, trimSpan, type Span } from './text';
import { explode, sound } from './fx';
import { tidyCut, toggleGhostSpan } from './actions';
import { isSentenceStart } from './grammar';

export type BrainSlot = 'words' | 'rewrites' | 'typos' | 'mechanical' | 'judgment' | 'trim';

export interface PassDef {
  id: string;
  name: string;
  blurb: string;
  kind: 'mark' | 'fix';
  target: 'sentences' | 'spans';
  brain: BrainSlot | Brain;
  instruction: string;
}

export const PASSES: PassDef[] = [
  {
    id: 'typos', name: 'Fix punctuation and typos', kind: 'fix', target: 'spans', brain: 'typos',
    blurb: 'Misspellings, doubled words, clear punctuation slips. Never your style.',
    instruction: "Find typos, misspellings, doubled words and clear punctuation mistakes. Leave style alone: fragments, lowercase, casual punctuation and odd word choices can be on purpose. Keep each fix as small as you can: quote just the word or the few characters that change.",
  },
  {
    id: 'weakest', name: 'Mark the weakest sentences', kind: 'mark', target: 'sentences', brain: 'judgment',
    blurb: 'The ones that sag, say nothing new, or bury the idea.',
    instruction: 'Mark the weakest sentences: the ones that sag, say nothing new, or bury the idea. At most about one sentence in six.',
  },
  {
    id: 'long', name: 'Mark sentences that run long', kind: 'mark', target: 'sentences', brain: 'mechanical',
    blurb: "Too many clauses to land in one breath. Long on purpose is fine.",
    instruction: 'Mark sentences that run long: too many words or clauses to land in one breath. A long sentence that earns it (rhythm, a deliberate pile-up) is fine; leave it.',
  },
  {
    id: 'convoluted', name: 'Mark convoluted sentences', kind: 'mark', target: 'sentences', brain: 'judgment',
    blurb: 'Tangled syntax: you have to read it twice.',
    instruction: 'Mark convoluted sentences: tangled syntax, buried subjects, a reader has to read it twice.',
  },
  {
    id: 'tone', name: "Mark words that don't fit the tone", kind: 'mark', target: 'spans', brain: 'judgment',
    blurb: 'Too formal, too jargony, too cute, off-register for this piece.',
    instruction: "Mark single words or short phrases that don't fit the tone of the piece: too formal, too jargony, too cute, off-register.",
  },
  {
    id: 'hedges', name: 'Mark hedges and filler', kind: 'mark', target: 'spans', brain: 'mechanical',
    blurb: 'just, really, sort of, I think, basically, in order to…',
    instruction: 'Mark hedges and filler: words and phrases that soften or pad without adding meaning (just, really, very, sort of, kind of, I think, perhaps, basically, actually, in order to, it seems). Skip the ones doing real work in the voice.',
  },
  {
    id: 'overexplain', name: 'Mark where it over-explains', kind: 'mark', target: 'sentences', brain: 'judgment',
    blurb: 'Explanation burying the spark: restating, justifying, telling what was already shown.',
    instruction: "Mark sentences that over-explain: they restate the point, justify what didn't need it, or explain what was already clear, until the live idea gets buried. This writer's known failure mode is exactly this, so look hard, but only mark what's really padding.",
  },
];

export const TRIMS: Array<{ level: number; name: string }> = [
  { level: 10, name: 'Slight trim' },
  { level: 20, name: 'Tighten more' },
  { level: 30, name: 'Even sharper' },
  { level: 50, name: 'Cut in half' },
];

interface Numbered { n: number; from: number; to: number }

interface RawItem { s?: unknown; text?: unknown; fix?: unknown; why?: unknown }

const SYSTEM = `You're an editor doing one pass over a writer's draft. You point; they decide.
It's their writing. Respect their voice; you're here to help it come through, not to replace it.
The draft comes as numbered sentences, "[12] Like this." A ¶ starts a new paragraph.
Quote exactly: any "text" you give must be copied character for character from that one sentence, so it can be found.
Be choosy. Mark only what earns it. If nothing does, return an empty list.
Reply with JSON only: {"items":[…]}`;

const NORM = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\n/g, ' ');

export class Passes {
  private cache = new Map<string, { doc: Text; state: PassState }>();
  private running = new WeakMap<EditorView, number>();
  private menuEl: HTMLElement | null = null;

  constructor(private plugin: WordplayPlugin) {}

  all(): PassDef[] {
    const custom = this.plugin.settings.customPasses
      .filter((p) => p.name.trim() && p.instruction.trim())
      .map((p): PassDef => ({
        id: `custom:${p.id}`, name: p.name.trim(), blurb: p.instruction.trim(), kind: 'mark',
        target: p.target, brain: p.brain, instruction: p.instruction.trim(),
      }));
    return [...PASSES, ...custom];
  }

  private brainFor(b: BrainSlot | Brain): Brain {
    return b === 'quick' || b === 'smart' ? b : this.plugin.settings.brains[b];
  }

  // ---- running ----

  private numbered(view: EditorView): { list: Numbered[]; prompt: string; scope: Span; words: number } {
    const doc = view.state.doc.toString();
    const sel = view.state.selection.main;
    const scope = sel.empty ? { from: 0, to: doc.length } : trimSpan(doc, { from: sel.from, to: sel.to });
    const list: Numbered[] = [];
    const lines: string[] = [];
    for (const block of proseBlocks(doc, scope.from, scope.to)) {
      const clipped = trimSpan(doc, { from: Math.max(block.from, scope.from), to: Math.min(block.to, scope.to) });
      if (clipped.to <= clipped.from) continue;
      lines.push('¶');
      for (const s of sentencesIn(doc, clipped)) {
        const n = list.length + 1;
        list.push({ n, ...s });
        lines.push(`[${n}] ${doc.slice(s.from, s.to).replace(/\s*\n\s*/g, ' ')}`);
      }
    }
    const words = sel.empty ? countBodyWords(doc) : countWords(doc, scope.from, scope.to);
    return { list, prompt: lines.join('\n'), scope, words };
  }

  /** run a pass (or a trim, with a level) over the note or the selection */
  async run(view: EditorView, which: { def: PassDef } | { trim: number }): Promise<void> {
    const overlay = overlayFor(view);
    if (!overlay) return;
    const path = this.plugin.pathOf(view);
    const trim = 'trim' in which ? which.trim : 0;
    const def = 'def' in which ? which.def : null;
    const label = def ? def.name : TRIMS.find((t) => t.level === trim)?.name ?? `Trim ${trim}%`;

    if (trim) {
      const cached = this.cache.get(`${path}|${trim}`);
      if (cached && cached.doc === view.state.doc) {
        view.dispatch({ effects: setPass.of({ ...cached.state, revealAt: Date.now(), current: null }) });
        this.showBar(view);
        return;
      }
    }

    const { list, prompt, words } = this.numbered(view);
    if (!list.length) { new Notice('nothing here to read yet.'); return; }

    const ticket = (this.running.get(view) ?? 0) + 1;
    this.running.set(view, ticket);
    const startDoc = view.state.doc;
    view.dispatch({ effects: setPass.of(null) });
    overlay.scanning(true);
    overlay.setBar((bar) => {
      bar.addClass('is-scanning');
      bar.createSpan({ cls: 'wp-bar-title', text: label });
      bar.createSpan({ cls: 'wp-bar-sub wp-dots', text: 'reading' });
      const stop = bar.createEl('button', { text: 'stop' });
      stop.addEventListener('click', () => { this.running.set(view, ticket + 1); overlay.scanning(false); overlay.setBar(null); });
    });

    let shape: string;
    let instruction: string;
    if (trim) {
      const target = Math.round(words * trim / 100);
      instruction = `Trim the draft by about ${trim}% of its words: about ${target} of its ${words}. Cut only. Never add, reorder or rewrite. Each cut is an exact piece of one sentence (a word, a phrase, a clause, or the whole sentence) that can go without breaking the grammar of what's left. Cut redundancy, throat-clearing, hedges, filler, repeated points, and explanation that buries the spark. Keep the voice and the live lines.${trim >= 50 ? ' At this level whole sentences and whole runs of explanation can go.' : ''} Cuts in one sentence must not overlap.`;
      shape = '{"s": sentence number, "text": "the exact words to cut", "why": "a few words"}';
    } else if (def!.kind === 'fix') {
      instruction = def!.instruction;
      shape = '{"s": sentence number, "text": "the exact text that is wrong", "fix": "what it should be", "why": "a few words"}';
    } else if (def!.target === 'spans') {
      instruction = def!.instruction;
      shape = '{"s": sentence number, "text": "the exact words", "why": "one short line"}';
    } else {
      instruction = def!.instruction;
      shape = '{"s": sentence number, "why": "one short line"}';
    }
    const voice = this.plugin.settings.voice.trim();
    const user = [
      `The pass: ${instruction}`,
      `Each item: ${shape}`,
      voice ? `About the writer: ${voice}` : '',
      `Note: ${this.plugin.titleOf(view)}`,
      `The draft:\n${prompt}`,
    ].filter(Boolean).join('\n\n');

    let raw: string;
    try {
      const brain = trim ? this.plugin.settings.brains.trim : this.brainFor(def!.brain);
      raw = await chat(this.plugin, brain, [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], {
        temperature: 0.3, maxTokens: trim ? 6000 : 4000,
      });
    } catch (e) {
      if (this.running.get(view) !== ticket) return;
      overlay.scanning(false);
      overlay.setBar(null);
      this.plugin.complain(e);
      return;
    }
    if (this.running.get(view) !== ticket) return;
    overlay.scanning(false);

    let items: RawItem[] = [];
    try {
      const parsed = parseJson<{ items?: RawItem[] } | RawItem[]>(raw);
      items = Array.isArray(parsed) ? parsed : parsed.items ?? [];
    } catch (e) {
      overlay.setBar(null);
      this.plugin.complain(e);
      return;
    }

    const kind: MarkType = trim ? 'cut' : def!.kind === 'fix' ? 'fix' : 'mark';
    const needText = kind !== 'mark' || def?.target === 'spans';
    const oldDoc = startDoc.toString();
    const used: Span[] = [];
    let marks: PassMark[] = [];
    for (const item of items) {
      const s = list[(typeof item.s === 'number' ? item.s : parseInt(String(item.s), 10)) - 1];
      if (!s) continue;
      let span: Span | null = { from: s.from, to: s.to };
      const text = typeof item.text === 'string' ? item.text : '';
      if (needText || text) span = text ? this.locate(oldDoc, s, text, used) : needText ? null : span;
      if (!span || used.some((u) => span!.from < u.to && span!.to > u.from)) continue;
      used.push(span);
      const why = typeof item.why === 'string' ? item.why : '';
      const fix = typeof item.fix === 'string' ? item.fix : undefined;
      if (kind === 'fix' && (fix === undefined || fix === oldDoc.slice(span.from, span.to))) continue;
      marks.push({ id: newId('m'), ...span, type: kind, why, ...(fix !== undefined ? { fix } : {}) });
    }
    marks.sort((a, b) => a.from - b.from);

    // you kept writing while it read: find each mark's words again
    if (view.state.doc !== startDoc) {
      const now = view.state.doc.toString();
      marks = marks.flatMap((m) => {
        const text = oldDoc.slice(m.from, m.to);
        const at = nearest(now, text, m.from);
        return at < 0 ? [] : [{ ...m, from: at, to: at + text.length }];
      });
    }

    const state: PassState = {
      passId: def?.id ?? `trim:${trim}`, label, kind, marks, revealAt: Date.now(), current: null,
      ...(trim ? { level: trim, wordsBefore: words } : {}),
    };
    view.dispatch({ effects: setPass.of(state) });
    if (trim) this.cache.set(`${path}|${trim}`, { doc: view.state.doc, state });
    if (marks.length) sound.settle();
    this.showBar(view);
  }

  private locate(doc: string, s: Numbered, text: string, used: Span[]): Span | null {
    const hay = doc.slice(s.from, s.to);
    const tries: Array<[string, string]> = [[hay, text], [NORM(hay), NORM(text)], [NORM(hay).toLowerCase(), NORM(text).toLowerCase()]];
    for (const [h, t] of tries) {
      if (!t.trim()) return null;
      for (let i = h.indexOf(t); i !== -1; i = h.indexOf(t, i + 1)) {
        const span = { from: s.from + i, to: s.from + i + t.length };
        if (!used.some((u) => span.from < u.to && span.to > u.from)) return span;
      }
    }
    return null;
  }

  // ---- the results bar ----

  showBar(view: EditorView): void {
    const overlay = overlayFor(view);
    const pass = view.state.field(passField, false);
    if (!overlay) return;
    if (!pass) { overlay.setBar(null); return; }
    const marks = pass.marks;
    overlay.setBar((bar) => {
      const head = bar.createDiv({ cls: 'wp-bar-head' });
      head.createSpan({ cls: 'wp-bar-title', text: pass.label });
      const sub = bar.createDiv({ cls: 'wp-bar-sub' });
      const buttons = bar.createDiv({ cls: 'wp-bar-buttons' });
      const button = (text: string, run: () => void, cls = '') => {
        const b = buttons.createEl('button', { text, cls });
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', run);
        return b;
      };

      if (!marks.length) {
        head.createSpan({ cls: 'wp-bar-stat', text: 'nothing to mark' });
        sub.setText(pass.kind === 'cut' ? 'It reads tight already.' : 'Clean.');
        button('Done', () => this.done(view));
        return;
      }
      if (pass.kind === 'cut') {
        const before = pass.wordsBefore ?? countBodyWords(view.state.doc.toString());
        const cutting = this.cutWords(view);
        const after = countBodyWords(view.state.doc.toString()) - cutting;
        const pct = before ? Math.round(((before - after) / before) * 100) : 0;
        head.createSpan({ cls: 'wp-bar-stat', text: `${before.toLocaleString()} → ${after.toLocaleString()} words · −${pct}%` });
        sub.setText('Faded words would go. Click one to keep it.');
        const make = button('Make the cuts', () => {
          buttons.empty();
          sub.setText(`Are you sure?? ${cutting.toLocaleString()} word${cutting === 1 ? '' : 's'} go. ⌘Z brings them back.`);
          button('Yes, cut them', () => this.applyAll(view), 'mod-warning');
          button('Wait, no', () => this.showBar(view));
        }, 'mod-cta');
        if (!cutting) make.disabled = true;
      } else if (pass.kind === 'fix') {
        head.createSpan({ cls: 'wp-bar-stat', text: `${marks.length} fix${marks.length === 1 ? '' : 'es'}` });
        sub.setText("Struck through is what's there; the fix sits beside it.");
        button('Fix all', () => {
          buttons.empty();
          sub.setText(`Are you sure?? ${marks.length} change${marks.length === 1 ? '' : 's'}. ⌘Z undoes them.`);
          button(`Yes, fix ${marks.length === 1 ? 'it' : 'them'}`, () => this.applyAll(view), 'mod-cta');
          button('Wait, no', () => this.showBar(view));
        }, 'mod-cta');
      } else {
        head.createSpan({ cls: 'wp-bar-stat', text: `${marks.length} marked` });
        sub.setText('Hover one for why. Click one for what you can do.');
      }
      button('Walk through', () => this.walk(view, marks[0]?.id ?? null));
      button('Done', () => this.done(view));
    });
  }

  private cutWords(view: EditorView): number {
    const pass = view.state.field(passField, false);
    if (!pass) return 0;
    const doc = view.state.doc.toString();
    return pass.marks.filter((m) => m.type === 'cut' && !m.kept).reduce((n, m) => n + countWords(doc, m.from, m.to), 0);
  }

  done(view: EditorView): void {
    this.closeCard(view);
    view.dispatch({ effects: setPass.of(null) });
    overlayFor(view)?.setBar(null);
    view.focus();
  }

  /** make every cut that isn't kept, or take every fix: one transaction, one ⌘Z */
  applyAll(view: EditorView): void {
    const pass = view.state.field(passField, false);
    if (!pass) return;
    const doc = view.state.doc.toString();
    const marks = pass.marks.filter((m) => (m.type === 'cut' ? !m.kept : m.type === 'fix'));
    const changes = this.changesFor(doc, marks);
    if (pass.kind === 'cut') {
      for (const m of marks) explode(view, m.from, m.to);
      sound.poof();
    } else sound.settle();
    const words = pass.kind === 'cut' ? marks.reduce((n, m) => n + countWords(doc, m.from, m.to), 0) : 0;
    this.closeCard(view);
    view.dispatch({ changes, effects: setPass.of(null), userEvent: 'delete.wordplay.pass' });
    this.cache.clear();
    const overlay = overlayFor(view);
    overlay?.setBar((bar) => {
      bar.createDiv({ cls: 'wp-bar-title', text: pass.kind === 'cut' ? `Cut ${words.toLocaleString()} words.` : `Fixed ${marks.length}.` });
      bar.createDiv({ cls: 'wp-bar-sub', text: '⌘Z brings it all back.' });
    });
    window.setTimeout(() => { if (overlay?.bar && !view.state.field(passField, false)) overlay.setBar(null); }, 4000);
    view.focus();
  }

  private changesFor(doc: string, marks: PassMark[]): ChangeSpec[] {
    const out: ChangeSpec[] = [];
    const sorted = [...marks].sort((a, b) => a.from - b.from);
    let last = -1;
    for (const m of sorted) {
      if (m.type === 'fix') { if (m.from >= last) { out.push({ from: m.from, to: m.to, insert: m.fix ?? '' }); last = m.to; } continue; }
      const cut = tidyCut(doc, m.from, m.to);
      if (cut.from < last) continue;
      // cutting the start of a sentence: the next word takes the capital
      const after = cut.to;
      const next = doc[after];
      if (isSentenceStart(doc, m.from) && next && /\p{Ll}/u.test(next) && !sorted.some((o) => o !== m && o.from <= after && o.to > after)) {
        out.push({ from: cut.from, to: after + 1, insert: next.toUpperCase() });
        last = after + 1;
      } else {
        out.push({ from: cut.from, to: cut.to, insert: '' });
        last = cut.to;
      }
    }
    return out;
  }

  // ---- one mark at a time ----

  clickMark(view: EditorView, mark: PassMark): void {
    if (mark.type === 'cut') {
      view.dispatch({ effects: patchMark.of({ id: mark.id, patch: { kept: !mark.kept } }) });
      (mark.kept ? sound.next : sound.home)();
      this.showBar(view);
      return;
    }
    this.walk(view, mark.id);
  }

  private closeCard(view: EditorView): void {
    overlayFor(view)?.setCard(null);
    if (view.state.field(passField, false)?.current) view.dispatch({ effects: setCurrentMark.of(null) });
  }

  /** a card by one mark: why it's marked, and what to do about it */
  walk(view: EditorView, id: string | null): void {
    const pass = view.state.field(passField, false);
    const overlay = overlayFor(view);
    if (!pass || !overlay) return;
    const marks = pass.marks;
    const at = marks.findIndex((m) => m.id === id);
    const mark = marks[at];
    if (!mark) { this.closeCard(view); this.showBar(view); view.focus(); return; }
    view.dispatch({ effects: [setCurrentMark.of(mark.id), EditorView.scrollIntoView(mark.from, { y: 'center' })] });

    const card = view.dom.createDiv({ cls: 'wp-card' });
    card.tabIndex = -1;
    overlay.setCard(card);
    const doc = view.state.doc.toString();
    const excerpt = doc.slice(mark.from, mark.to);
    card.createDiv({ cls: 'wp-card-count', text: `${at + 1} of ${marks.length}` });
    const what = card.createDiv({ cls: 'wp-card-what' });
    if (mark.type === 'fix') {
      what.createSpan({ cls: 'wp-card-old', text: excerpt });
      what.createSpan({ text: ' → ' });
      what.createSpan({ cls: 'wp-card-new', text: mark.fix || '(nothing)' });
    } else if (mark.type === 'cut') {
      what.createSpan({ cls: mark.kept ? 'wp-card-kept' : 'wp-card-old', text: excerpt.length > 140 ? `${excerpt.slice(0, 140)}…` : excerpt });
    } else {
      what.setText(excerpt.length > 140 ? `${excerpt.slice(0, 140)}…` : excerpt);
    }
    if (mark.why) card.createDiv({ cls: 'wp-card-why', text: mark.why });
    const buttons = card.createDiv({ cls: 'wp-card-buttons' });
    const keys = new Map<string, () => void>();
    const button = (text: string, key: string, run: () => void, cls = '') => {
      const b = buttons.createEl('button', { cls });
      b.createSpan({ text });
      b.createEl('kbd', { text: key });
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', run);
      keys.set(key.toLowerCase(), run);
    };
    const next = () => {
      const now = view.state.field(passField, false)?.marks ?? [];
      const after = now.find((m) => m.from > mark.from && m.id !== mark.id) ?? null;
      this.walk(view, after?.id ?? null);
    };
    const prev = () => {
      const now = view.state.field(passField, false)?.marks ?? [];
      const before = [...now].reverse().find((m) => m.from < mark.from) ?? null;
      if (before) this.walk(view, before.id);
    };
    const drop = () => view.dispatch({ effects: patchMark.of({ id: mark.id, patch: null }) });

    if (mark.type === 'cut') {
      button('Cut it', '↵', () => {
        const cut = tidyCut(view.state.doc.toString(), mark.from, mark.to);
        explode(view, mark.from, mark.to);
        sound.poof();
        view.dispatch({ changes: { from: cut.from, to: cut.to, insert: '' }, userEvent: 'delete.wordplay.pass' });
        drop();
        this.cache.clear();
        next();
        this.showBar(view);
      }, 'mod-cta');
      button(mark.kept ? 'Kept' : 'Keep it', 'K', () => {
        view.dispatch({ effects: patchMark.of({ id: mark.id, patch: { kept: true } }) });
        next();
        this.showBar(view);
      });
    } else if (mark.type === 'fix') {
      button('Fix it', '↵', () => {
        view.dispatch({ changes: { from: mark.from, to: mark.to, insert: mark.fix ?? '' }, userEvent: 'input.wordplay.pass' });
        drop();
        sound.next();
        next();
        this.showBar(view);
      }, 'mod-cta');
      button('Skip', 'S', () => { drop(); next(); this.showBar(view); });
    } else {
      const unit = classify(doc, mark);
      button('Try alternatives', 'A', () => {
        drop();
        this.closeCard(view);
        this.showBar(view);
        void this.plugin.askAiFor(view, { from: mark.from, to: mark.to, unit, choice: null });
      }, 'mod-cta');
      button('Ghost it', 'G', () => {
        toggleGhostSpan(view, mark.from, mark.to);
        drop();
        next();
        this.showBar(view);
      });
      button('Fine as is', 'N', () => { drop(); next(); this.showBar(view); });
    }
    const nav = card.createDiv({ cls: 'wp-card-nav' });
    nav.setText('← → to move · esc to stop');

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.closeCard(view); view.focus(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next();
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') prev();
      else if (e.key === 'Enter') keys.get('↵')?.();
      else keys.get(e.key.toLowerCase())?.();
      e.preventDefault();
      e.stopPropagation();
    });

    // after the scroll lands, sit just below the mark (or above it near the bottom)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!card.isConnected) return;
      const coords = view.coordsAtPos(mark.to, -1) ?? view.coordsAtPos(mark.from, 1);
      const box = view.dom.getBoundingClientRect();
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      if (coords) {
        let top = coords.bottom - box.top + 10;
        if (top + h > box.height - 90) top = coords.top - box.top - h - 10;
        card.style.top = `${Math.max(8, top)}px`;
        card.style.left = `${Math.max(12, Math.min(coords.left - box.left - 40, box.width - w - 12))}px`;
      }
      card.addClass('is-open');
      card.focus({ preventScroll: true });
    }));
  }

  // ---- the passes menu, above the chip ----

  openMenu(view: EditorView): void {
    this.closeMenu();
    const overlay = overlayFor(view);
    if (!overlay) return;
    const all = this.all();
    const pass = view.state.field(passField, false);
    const sel = view.state.selection.main;
    const el = document.body.createDiv({ cls: 'wp-passes' });
    el.tabIndex = -1;
    this.menuEl = el;

    const top = el.createDiv({ cls: 'wp-passes-top' });
    const filter = top.createEl('input', { type: 'text', placeholder: 'Passes…', cls: 'wp-passes-filter' });
    top.createSpan({ cls: 'wp-passes-scope', text: sel.empty ? 'the whole note' : 'the selection' });
    const list = el.createDiv({ cls: 'wp-passes-list' });
    const trims = el.createDiv({ cls: 'wp-trims' });

    type Row = { el: HTMLElement; run: () => void; def?: PassDef };
    let rows: Row[] = [];
    let index = 0;
    const trimRows: Row[] = [];
    const activeTrim = pass?.kind === 'cut' ? pass.level ?? 0 : 0;

    const levels = [{ level: 0, name: 'Original' }, ...TRIMS];
    for (const t of levels) {
      const b = trims.createDiv({ cls: 'wp-trim' + (t.level === activeTrim ? ' is-on' : '') });
      b.createDiv({ cls: 'wp-trim-name', text: t.name });
      if (t.level) b.createDiv({ cls: 'wp-trim-pct', text: `~${t.level}%` });
      const run = () => {
        this.closeMenu();
        if (!t.level) { if (view.state.field(passField, false)?.kind === 'cut') this.done(view); else view.focus(); return; }
        void this.run(view, { trim: t.level });
      };
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', run);
      trimRows.push({ el: b, run });
    }

    const render = () => {
      list.empty();
      const q = filter.value.trim().toLowerCase();
      const shown = all.filter((p) => !q || p.name.toLowerCase().includes(q) || p.blurb.toLowerCase().includes(q));
      rows = shown.map((def) => {
        const row = list.createDiv({ cls: 'wp-passes-row' });
        row.createDiv({ cls: 'wp-passes-name', text: def.name });
        row.createDiv({ cls: 'wp-passes-blurb', text: def.blurb });
        const run = () => { this.closeMenu(); void this.run(view, { def }); };
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', run);
        return { el: row, run, def };
      });
      if (!rows.length) list.createDiv({ cls: 'wp-passes-empty', text: 'No pass by that name. Make your own in settings.' });
      index = Math.min(index, rows.length + trimRows.length - 1);
      paint();
    };
    const everything = () => [...rows, ...trimRows];
    const paint = () => everything().forEach((r, i) => r.el.toggleClass('is-active', i === index));
    filter.addEventListener('input', () => { index = 0; render(); });
    el.addEventListener('keydown', (e) => {
      const n = everything().length;
      const inTrims = index >= rows.length;
      const homeTrim = rows.length + Math.max(0, levels.findIndex((l) => l.level === activeTrim));
      if (e.key === 'ArrowDown') { index = inTrims ? index : index < rows.length - 1 ? index + 1 : homeTrim; paint(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { index = inTrims ? Math.max(0, rows.length - 1) : Math.max(0, index - 1); paint(); e.preventDefault(); }
      else if (e.key === 'ArrowRight' && inTrims) { index = Math.min(n - 1, index + 1); paint(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' && inTrims) { index = Math.max(rows.length, index - 1); paint(); e.preventDefault(); }
      else if (e.key === 'Enter') { everything()[index]?.run(); e.preventDefault(); }
      else if (e.key === 'Escape') { this.closeMenu(); view.focus(); e.preventDefault(); }
      e.stopPropagation();
    });
    render();

    // sit above the chip (or the middle of the bottom of the editor)
    const anchor = (overlay.chip.isShown() && !overlay.chip.hasClass('is-hidden') ? overlay.chip : overlay.bar ?? view.dom).getBoundingClientRect();
    const box = view.dom.getBoundingClientRect();
    const width = Math.min(560, box.width - 32);
    el.style.width = `${width}px`;
    const centre = anchor === box ? box.left + box.width / 2 : anchor.left + anchor.width / 2;
    el.style.left = `${Math.max(8, Math.min(centre - width / 2, window.innerWidth - width - 8))}px`;
    el.style.bottom = `${Math.max(8, window.innerHeight - (anchor === box ? box.bottom - 40 : anchor.top) + 10)}px`;
    el.addClass('is-open');
    filter.focus();

    const outside = (e: MouseEvent) => { if (!el.contains(e.target as Node)) this.closeMenu(); };
    window.setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
    (el as HTMLElement & { wpCleanup?: () => void }).wpCleanup = () => document.removeEventListener('mousedown', outside, true);
  }

  closeMenu(): void {
    const el = this.menuEl as (HTMLElement & { wpCleanup?: () => void }) | null;
    el?.wpCleanup?.();
    el?.remove();
    this.menuEl = null;
  }

  forget(): void { this.cache.clear(); }
}

export { AiError };
