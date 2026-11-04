/**
 * What lives on top of the draft without changing it:
 *   a choice   a spot with alternatives (the original, yours, the AI's); the doc shows the active one
 *   a ghost    a dimmed stretch, so you can read the page as if it weren't there
 * A choice can sit inside another one's text (a word inside a sentence you're also playing with).
 * When the outer one swaps, whatever lived inside the outgoing text is tucked into that option,
 * and comes back when you swap back to it. Alternative control, not version control.
 */
import type { ChangeSet, Text } from '@codemirror/state';
import { isWordChar, type Unit } from './text';

export type Source = 'original' | 'human' | 'ai';

export interface Option {
  id: string;
  text: string;
  source: Source;
  why?: string;
  /** choices and ghosts that lived inside this option's text, positions relative to its start */
  inner?: Item[];
}

export interface Choice {
  kind: 'choice';
  id: string;
  from: number;
  to: number;
  unit: Unit;
  options: Option[];
  active: number;
}

export interface Ghost {
  kind: 'ghost';
  id: string;
  from: number;
  to: number;
  text: string;
}

export type Item = Choice | Ghost;

let counter = 0;
export function newId(prefix = 'w'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function isChoice(item: Item | null | undefined): item is Choice { return item?.kind === 'choice'; }
export function isGhost(item: Item | null | undefined): item is Ghost { return item?.kind === 'ghost'; }

/** the text a choice or ghost expects to find in the doc */
export function shownText(item: Item): string {
  return item.kind === 'choice' ? item.options[item.active]?.text ?? '' : item.text;
}

export function sortItems(items: Item[]): Item[] {
  return [...items].sort((a, b) => a.from - b.from || b.to - a.to);
}

const WORDISH = /^[\p{L}\p{N}'’-]+$/u;

/**
 * Items follow the text as you type. Typing at a choice's edge stays outside it,
 * unless you're carrying on the same word ("struggle" + "s" grows the choice).
 * A choice or ghost whose text is all gone goes too. A choice's active option is always
 * whatever the doc says between its ends.
 */
export function mapItems(items: Item[], changes: ChangeSet, newDoc: Text): Item[] {
  const out: Item[] = [];
  for (const item of items) {
    let from = changes.mapPos(item.from, 1);
    let to = changes.mapPos(item.to, -1);
    const before = shownText(item);
    changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (fromA !== toA || !inserted.length) return;
      const ins = inserted.toString();
      if (!WORDISH.test(ins)) return;
      if (fromA === item.to && isWordChar(before[before.length - 1])) to = toB;
      if (fromA === item.from && isWordChar(before[0])) from = fromB;
    });
    if (to <= from) continue;
    const text = newDoc.sliceString(from, to);
    if (item.kind === 'ghost') {
      out.push(item.from === from && item.to === to && item.text === text ? item : { ...item, from, to, text });
    } else {
      const active = item.options[item.active];
      const options = active && active.text !== text ? item.options.map((o, i) => (i === item.active ? { ...o, text } : o)) : item.options;
      out.push(item.from === from && item.to === to && options === item.options ? item : { ...item, from, to, options });
    }
  }
  return out;
}

/** one item through a change (for effects carried in the undo history) */
export function mapItem(item: Item, changes: { mapPos(pos: number, assoc?: number): number }): Item | null {
  const from = changes.mapPos(item.from, 1);
  const to = changes.mapPos(item.to, -1);
  if (to <= from) return null;
  return { ...item, from, to };
}

/** the occurrence of `needle` nearest to `near`, or -1 */
export function nearest(haystack: string, needle: string, near: number): number {
  if (!needle) return -1;
  let best = -1;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    if (best === -1 || Math.abs(i - near) < Math.abs(best - near)) best = i;
    if (i > near && best !== -1 && i - near > Math.abs(best - near)) break;
  }
  return best;
}

/**
 * After the whole note was replaced (it changed on disk, or a fuse burned), find each item's
 * text again near where it was. What can't be found is let go.
 */
export function reanchor(items: Item[], doc: string): Item[] {
  const out: Item[] = [];
  const taken: Array<[number, number]> = [];
  for (const item of sortItems(items)) {
    const text = shownText(item);
    const at = item.from >= 0 && doc.slice(item.from, item.to) === text ? item.from : nearest(doc, text, item.from);
    if (at < 0) continue;
    const span: [number, number] = [at, at + text.length];
    // two choices can't land on the same text
    if (item.kind === 'choice' && taken.some(([f, t]) => f === span[0] && t === span[1])) continue;
    if (item.kind === 'choice') taken.push(span);
    out.push({ ...item, from: span[0], to: span[1] });
  }
  return sortItems(out);
}

// ---- finding things ----

export function choices(items: Item[]): Choice[] { return items.filter(isChoice); }
export function ghosts(items: Item[]): Ghost[] { return items.filter(isGhost); }

/** the innermost choice at a position (ends count) */
export function choiceAt(items: Item[], pos: number): Choice | null {
  let best: Choice | null = null;
  for (const c of choices(items)) {
    if (pos >= c.from && pos <= c.to && (!best || c.to - c.from < best.to - best.from)) best = c;
  }
  return best;
}

export function choiceById(items: Item[], id: string | null | undefined): Choice | null {
  const it = id ? items.find((i) => i.id === id) : null;
  return isChoice(it) ? it : null;
}

export function ghostAt(items: Item[], pos: number): Ghost | null {
  return ghosts(items).find((g) => pos >= g.from && pos <= g.to) ?? null;
}

/** the choice that already covers exactly this span */
export function choiceOn(items: Item[], from: number, to: number): Choice | null {
  return choices(items).find((c) => c.from === from && c.to === to) ?? null;
}

/**
 * Can a new choice go here? It can sit inside another choice, or hold others inside it,
 * but it can't half-overlap one: that would leave a swap with no clean edges.
 */
export function overlapping(items: Item[], from: number, to: number): Choice | null {
  for (const c of choices(items)) {
    const disjoint = to <= c.from || from >= c.to;
    const inside = from >= c.from && to <= c.to;
    const around = from <= c.from && to >= c.to;
    if (!disjoint && !inside && !around) return c;
  }
  return null;
}

/** the items living inside a choice's current text, made relative to its start */
export function tuckInner(items: Item[], outer: Choice): Item[] {
  return items
    .filter((i) => i.id !== outer.id && i.from >= outer.from && i.to <= outer.to && !(i.from === outer.from && i.to === outer.to && i.kind === 'choice'))
    .map((i) => ({ ...i, from: i.from - outer.from, to: i.to - outer.from }));
}

export function untuck(stored: Item[] | undefined, base: number): Item[] {
  return (stored ?? []).map((i) => ({ ...i, from: i.from + base, to: i.to + base }));
}

// ---- saving ----

export interface StoredFile { v: 1; items: Item[] }

/** what's worth keeping: choices with somewhere to go, and ghosts */
export function toStore(items: Item[]): StoredFile | null {
  const keep = items.filter((i) => i.kind === 'ghost' || i.options.length > 1);
  return keep.length ? { v: 1, items: keep } : null;
}

export function fromStore(stored: unknown, doc: string): Item[] {
  const s = stored as Partial<StoredFile> | null | undefined;
  if (!s || !Array.isArray(s.items)) return [];
  const valid = s.items.filter((i): i is Item =>
    !!i && typeof i.id === 'string' && typeof i.from === 'number' && typeof i.to === 'number'
    && (i.kind === 'ghost' ? typeof i.text === 'string' : i.kind === 'choice' && Array.isArray(i.options) && i.options.length > 0));
  return reanchor(valid.map((i) => (i.kind === 'choice' ? { ...i, active: Math.min(Math.max(0, i.active | 0), i.options.length - 1) } : i)), doc);
}
