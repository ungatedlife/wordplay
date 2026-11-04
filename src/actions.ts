/**
 * Everything you can do to a choice or a ghost, as editor transactions (so ⌘Z undoes each one).
 */
import { EditorSelection, type ChangeSet, type ChangeSpec, type EditorState, type StateEffect, type Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { articleFix, fitCase } from './grammar';
import {
  choiceAt, choiceById, choiceOn, ghostAt, ghosts, isChoice, newId, overlapping, tuckInner, untuck,
  type Choice, type Ghost, type Item, type Option,
} from './items';
import { itemsField, litField, pendingField, putItem, setLit, setPending } from './state';
import { classify, sentenceAt, spanFor, trimSpan, type Unit } from './text';
import { explode, sound } from './fx';

export function itemsOf(state: EditorState): Item[] {
  return state.field(itemsField, false)?.items ?? [];
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

// ---- where the panel and the menu are pointed ----

export interface Target { from: number; to: number; unit: Unit; choice: Choice | null }

/** what you're working on: the selection, the spot the panel's holding, or the word/sentence/paragraph at the cursor */
export function targetAt(state: EditorState, unit?: Unit): Target | null {
  const items = itemsOf(state);
  const doc = state.doc.toString();
  const sel = state.selection.main;
  if (!sel.empty) {
    const span = trimSpan(doc, { from: sel.from, to: sel.to });
    if (span.to <= span.from) return null;
    const existing = choiceOn(items, span.from, span.to);
    return { ...span, unit: existing?.unit ?? classify(doc, span), choice: existing };
  }
  const pending = state.field(pendingField, false);
  if (pending && (!unit || unit === pending.unit)) {
    return { ...pending, choice: choiceOn(items, pending.from, pending.to) };
  }
  const pos = sel.head;
  if (!unit) {
    const lit = choiceById(items, state.field(litField, false));
    const inner = lit ?? choiceAt(items, pos);
    if (inner) return { from: inner.from, to: inner.to, unit: inner.unit, choice: inner };
  } else {
    const containing = items.filter((i): i is Choice => isChoice(i) && i.unit === unit && pos >= i.from && pos <= i.to)
      .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
    if (containing) return { from: containing.from, to: containing.to, unit, choice: containing };
  }
  const u = unit ?? 'word';
  const span = spanFor(doc, pos, u);
  if (!span) return null;
  return { ...span, unit: u, choice: choiceOn(items, span.from, span.to) };
}

export function pin(view: EditorView, target: Target | null): void {
  view.dispatch({ effects: setPending.of(target && !target.choice ? { from: target.from, to: target.to, unit: target.unit } : null) });
}

// ---- making choices ----

export type Made = { choice: Choice } | { blocked: Choice } | { nothing: true };

/** a choice on this span (or the one already there), with these options added; optionally showing the first new one */
export function addAlternatives(view: EditorView, target: Target, more: Array<Pick<Option, 'text' | 'source' | 'why'>>, show = false): Made {
  const state = view.state;
  const items = itemsOf(state);
  let choice = target.choice ? choiceById(items, target.choice.id) : choiceOn(items, target.from, target.to);
  let created = false;
  if (!choice) {
    const blocker = overlapping(items, target.from, target.to);
    if (blocker) return { blocked: blocker };
    choice = {
      kind: 'choice', id: newId('c'), from: target.from, to: target.to, unit: target.unit, active: 0,
      options: [{ id: newId('o'), text: state.sliceDoc(target.from, target.to), source: 'original' }],
    };
    created = true;
  }
  const seen = new Set(choice.options.map((o) => norm(o.text)));
  const fresh: Option[] = [];
  for (const o of more) {
    const text = o.text.replace(/\s+$/g, '');
    if (!text.trim() || seen.has(norm(text))) continue;
    seen.add(norm(text));
    fresh.push({ id: newId('o'), text, source: o.source, ...(o.why ? { why: o.why } : {}) });
  }
  if (!fresh.length && !created) return { nothing: true };
  const next: Choice = { ...choice, options: [...choice.options, ...fresh] };
  if (show && fresh.length) {
    const spec = swapSpec(state, next, choice.options.length);
    view.dispatch({ changes: spec.changes, effects: [...spec.effects, setPending.of(null)], selection: spec.selection, userEvent: 'wordplay.add' });
    sound.next();
    return { choice: spec.choice };
  }
  view.dispatch({ effects: [putItem.of({ id: next.id, item: next }), setPending.of(null)], userEvent: 'wordplay.add' });
  return { choice: next };
}

// ---- swapping ----

interface SwapSpec { changes: ChangeSet; effects: StateEffect<unknown>[]; choice: Choice; selection?: EditorSelection }

/**
 * The transaction that shows option `index` of `c`: the text swaps, a/an before it agrees,
 * what lived inside the outgoing text is tucked away with it, and what lives in the incoming one comes back.
 */
function swapSpec(state: EditorState, c: Choice, index: number): SwapSpec {
  const items = itemsOf(state);
  const doc = state.doc.toString();
  const inner = tuckInner(items, c);
  const outgoing: Option = { ...c.options[c.active], text: state.sliceDoc(c.from, c.to) };
  if (inner.length) outgoing.inner = inner; else delete outgoing.inner;
  const incoming = c.options[index];
  const insert = fitCase(doc, c.from, incoming.text, c.options[0]?.text ?? '');

  const specs: ChangeSpec[] = [{ from: c.from, to: c.to, insert }];
  const article = articleFix(doc, c.from, insert);
  if (article) specs.push(article);
  const changes = state.changes(specs);
  const newDoc = changes.apply(state.doc);
  const from = changes.mapPos(c.from, -1);
  const to = from + insert.length;

  const options = c.options.map((o, i) => {
    if (i === c.active && i !== index) return outgoing;
    if (i === index) { const o2: Option = { ...o, text: insert }; delete o2.inner; return o2; }
    return o;
  });
  const choice: Choice = { ...c, from, to, options, active: index };
  const effects: StateEffect<unknown>[] = [putItem.of({ id: c.id, item: choice })];
  for (const i of inner) effects.push(putItem.of({ id: i.id, item: null }));
  for (const i of untuck(incoming.inner, from)) effects.push(putItem.of({ id: i.id, item: i }));
  for (const holder of holders(items, c, inner)) effects.push(putItem.of({ id: holder.id, item: reshape(holder, c, from, to, changes, newDoc) }));

  const head = state.selection.main.head;
  const selection = head >= c.from && head <= c.to ? EditorSelection.single(to) : undefined;
  return { changes, effects, choice, selection };
}

/** items wrapped around a choice that share one of its edges (they'd lose the swapped text at that edge otherwise) */
function holders(items: Item[], c: Choice, inner: Item[]): Item[] {
  const tucked = new Set(inner.map((i) => i.id));
  return items.filter((i) => i.id !== c.id && !tucked.has(i.id) && i.from <= c.from && i.to >= c.to && (i.from === c.from || i.to === c.to));
}

function reshape(holder: Item, c: Choice, from: number, to: number, changes: ChangeSet, doc: Text): Item {
  const f = holder.from === c.from ? from : changes.mapPos(holder.from, 1);
  const t = holder.to === c.to ? to : changes.mapPos(holder.to, -1);
  const text = doc.sliceString(f, t);
  if (holder.kind === 'ghost') return { ...holder, from: f, to: t, text };
  return { ...holder, from: f, to: t, options: holder.options.map((o, i) => (i === holder.active ? { ...o, text } : o)) };
}

export function setActive(view: EditorView, id: string, index: number, opts: { lit?: boolean; quiet?: boolean } = {}): boolean {
  const c = choiceById(itemsOf(view.state), id);
  if (!c || index < 0 || index >= c.options.length) return false;
  if (index === c.active) { if (opts.lit) view.dispatch({ effects: setLit.of(c.id) }); return true; }
  const spec = swapSpec(view.state, c, index);
  const effects = opts.lit ? [...spec.effects, setLit.of(c.id)] : spec.effects;
  view.dispatch({ changes: spec.changes, effects, selection: spec.selection, userEvent: 'wordplay.swap' });
  if (!opts.quiet) (index === 0 ? sound.home : sound.next)();
  return true;
}

/** the choice under the cursor (or the one you're already cycling) */
export function currentChoice(state: EditorState): Choice | null {
  const items = itemsOf(state);
  return choiceById(items, state.field(litField, false)) ?? choiceAt(items, state.selection.main.head);
}

/** next or previous alternative, wrapping round */
export function cycle(view: EditorView, dir: 1 | -1): boolean {
  const c = currentChoice(view.state);
  if (!c) return false;
  if (c.options.length < 2) { sound.nope(); view.dispatch({ effects: setLit.of(c.id) }); return true; }
  const n = c.options.length;
  return setActive(view, c.id, (c.active + dir + n) % n, { lit: true });
}

/**
 * Explode an option. The original can't go (it's home). If it's the one showing,
 * it bursts on the page and the next one slides into its place. ⌘Z brings it back.
 */
export function explodeOption(view: EditorView, id: string, index: number): 'gone' | 'original' | 'missing' {
  const state = view.state;
  const c = choiceById(itemsOf(state), id);
  if (!c || !c.options[index]) return 'missing';
  if (index === 0) { sound.nope(); return 'original'; }
  sound.poof();
  if (index !== c.active) {
    const options = c.options.filter((_, i) => i !== index);
    const active = c.active > index ? c.active - 1 : c.active;
    view.dispatch({ effects: putItem.of({ id, item: { ...c, options, active } }), userEvent: 'wordplay.explode' });
    return 'gone';
  }
  explode(view, c.from, c.to);
  const slide = index < c.options.length - 1 ? index + 1 : index - 1;
  const spec = swapSpec(state, c, slide);
  const options = spec.choice.options.filter((_, i) => i !== index);
  const choice: Choice = { ...spec.choice, options, active: slide > index ? slide - 1 : slide };
  const effects = spec.effects.map((e) => (e.is(putItem) && e.value.id === id ? putItem.of({ id, item: choice }) : e));
  const lit = state.field(litField, false) === id;
  view.dispatch({ changes: spec.changes, effects: lit ? [...effects, setLit.of(id)] : effects, selection: spec.selection, userEvent: 'wordplay.explode' });
  return 'gone';
}

/** keep what's showing and let the alternatives go */
export function settle(view: EditorView, id: string): void {
  if (!choiceById(itemsOf(view.state), id)) return;
  view.dispatch({ effects: [putItem.of({ id, item: null }), setLit.of(null)], userEvent: 'wordplay.settle' });
  sound.settle();
}

export function settleAll(view: EditorView): number {
  const all = itemsOf(view.state).filter(isChoice);
  if (!all.length) return 0;
  view.dispatch({ effects: [...all.map((c) => putItem.of({ id: c.id, item: null })), setLit.of(null)], userEvent: 'wordplay.settle' });
  sound.settle();
  return all.length;
}

/** every choice back to its original, outermost first */
export function allOriginal(view: EditorView): number {
  let n = 0;
  for (let guard = 0; guard < 400; guard++) {
    const off = itemsOf(view.state).filter((i): i is Choice => isChoice(i) && i.active !== 0)
      .sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
    if (!off) break;
    setActive(view, off.id, 0, { quiet: true });
    n++;
  }
  if (n) sound.home();
  return n;
}

// ---- ghosts ----

/** ghost the selection (or the sentence at the cursor); inside a ghost, bring it back */
export function toggleGhost(view: EditorView): 'ghosted' | 'back' | 'nothing' {
  const state = view.state;
  const items = itemsOf(state);
  const sel = state.selection.main;
  const doc = state.doc.toString();
  const here = ghostAt(items, sel.head);
  if (sel.empty && here) { unghost(view, here.id); return 'back'; }
  let span = sel.empty ? sentenceAt(doc, sel.head) : trimSpan(doc, { from: sel.from, to: sel.to });
  if (!span || span.to <= span.from) return 'nothing';
  if (!sel.empty && here && span.from >= here.from && span.to <= here.to) { unghost(view, here.id); return 'back'; }
  // overlapping ghosts melt into one
  const melt = ghosts(items).filter((g) => g.to >= span!.from && g.from <= span!.to);
  for (const g of melt) span = { from: Math.min(span.from, g.from), to: Math.max(span.to, g.to) };
  const ghost: Ghost = { kind: 'ghost', id: newId('g'), from: span.from, to: span.to, text: state.sliceDoc(span.from, span.to) };
  view.dispatch({
    effects: [...melt.map((g) => putItem.of({ id: g.id, item: null })), putItem.of({ id: ghost.id, item: ghost })],
    selection: EditorSelection.cursor(sel.head), userEvent: 'wordplay.ghost',
  });
  return 'ghosted';
}

/** ghost exactly this stretch (melting into any ghost it touches) */
export function toggleGhostSpan(view: EditorView, from: number, to: number): void {
  const items = itemsOf(view.state);
  let span = { from, to };
  const melt = ghosts(items).filter((g) => g.to >= from && g.from <= to);
  for (const g of melt) span = { from: Math.min(span.from, g.from), to: Math.max(span.to, g.to) };
  const ghost: Ghost = { kind: 'ghost', id: newId('g'), ...span, text: view.state.sliceDoc(span.from, span.to) };
  view.dispatch({ effects: [...melt.map((g) => putItem.of({ id: g.id, item: null })), putItem.of({ id: ghost.id, item: ghost })], userEvent: 'wordplay.ghost' });
}

export function unghost(view: EditorView, id: string): void {
  view.dispatch({ effects: putItem.of({ id, item: null }), userEvent: 'wordplay.ghost' });
}

export function unghostAll(view: EditorView): number {
  const all = ghosts(itemsOf(view.state));
  if (all.length) view.dispatch({ effects: all.map((g) => putItem.of({ id: g.id, item: null })), userEvent: 'wordplay.ghost' });
  return all.length;
}

// ---- cutting ----

/** a cut that doesn't leave a double space or a space before punctuation */
export function tidyCut(doc: string, from: number, to: number): { from: number; to: number } {
  const before = doc[from - 1];
  const after = doc[to];
  if (after === ' ' && (from === 0 || before === undefined || /\s/.test(before) || /[(“"‘'[]/.test(before))) return { from, to: to + 1 };
  if (before === ' ' && (after === undefined || /[\s.,;:!?)\]”’"']/.test(after))) {
    // "the whole job, honestly." loses ", honestly", not just the word
    if (after !== undefined && /[.;:!?)]/.test(after) && doc[from - 2] === ',') return { from: from - 2, to };
    return { from: from - 1, to };
  }
  return { from, to };
}

/** delete a stretch with a bang (⌘Z puts it back) */
export function cutWithBang(view: EditorView, from: number, to: number): void {
  const doc = view.state.doc.toString();
  const cut = tidyCut(doc, from, to);
  explode(view, from, to);
  sound.poof();
  view.dispatch({ changes: { from: cut.from, to: cut.to, insert: '' }, userEvent: 'delete.wordplay' });
}
