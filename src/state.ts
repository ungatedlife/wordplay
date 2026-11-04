/**
 * The editor's memory: choices and ghosts (undoable, saved), plus things that only matter right now:
 * the spot the panel is working on, the choice you're cycling through, edit mode, and a pass's marks.
 *
 * Every change to a choice or ghost travels as a `putItem` effect, and `invertedEffects` hands the
 * history its opposite, so ⌘Z undoes a swap, an added option, an explosion or a ghost, in step with the text.
 */
import { EditorState, StateEffect, StateField, type Transaction } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';
import { editorInfoField } from 'obsidian';
import { mapItem, mapItems, reanchor, sortItems, type Item } from './items';
import type { Unit } from './text';

// ---- choices and ghosts ----

export interface ItemsState { path: string | null; loaded: boolean; items: Item[] }

/** put (or with null, take away) one item. Positions are in the document after the transaction's changes. */
export const putItem = StateEffect.define<{ id: string; item: Item | null }>({
  map: (v, mapping) => {
    if (!v.item) return v;
    const item = mapItem(v.item, mapping);
    return item ? { id: v.id, item } : undefined;
  },
});

/** load a note's items from the store (not part of history) */
export const loadItems = StateEffect.define<{ path: string; items: Item[] }>();

function pathOf(state: EditorState): string | null {
  const info = state.field(editorInfoField, false);
  return info?.file?.path ?? null;
}

/** a transaction that swaps the whole note for another text (a reload from disk, a burned fuse) */
function replacesEverything(tr: Transaction): boolean {
  if (!tr.docChanged || tr.startState.doc.length === 0) return false;
  let whole = false;
  tr.changes.iterChangedRanges((fromA, toA) => { if (fromA === 0 && toA === tr.startState.doc.length) whole = true; });
  return whole && !tr.isUserEvent('input') && !tr.isUserEvent('delete') && !tr.isUserEvent('undo') && !tr.isUserEvent('redo');
}

export const itemsField = StateField.define<ItemsState>({
  create: (state) => ({ path: pathOf(state), loaded: false, items: [] }),
  update(value, tr) {
    const path = pathOf(tr.state);
    if (path !== value.path) return { path, loaded: false, items: [] };
    let { items, loaded } = value;
    for (const e of tr.effects) {
      if (e.is(loadItems) && e.value.path === path) { items = sortItems(e.value.items); loaded = true; }
    }
    if (tr.docChanged && items.length) {
      items = replacesEverything(tr) ? reanchor(items, tr.state.doc.toString()) : mapItems(items, tr.changes, tr.state.doc);
    }
    let touched = false;
    for (const e of tr.effects) {
      if (!e.is(putItem)) continue;
      if (!touched) { items = items.slice(); touched = true; }
      const at = items.findIndex((i) => i.id === e.value.id);
      if (at >= 0) items.splice(at, 1);
      if (e.value.item) items.push(e.value.item);
    }
    if (touched) items = sortItems(items);
    return items === value.items && loaded === value.loaded ? value : { path, loaded, items };
  },
});

/** the opposite of each transaction's item changes, for ⌘Z */
const undoItems = invertedEffects.of((tr) => {
  const before = tr.startState.field(itemsField, false);
  const after = tr.state.field(itemsField, false);
  if (!before || !after || before.items === after.items) return [];
  if (tr.effects.some((e) => e.is(loadItems)) || before.path !== after.path) return [];
  const ids = new Set<string>();
  for (const e of tr.effects) if (e.is(putItem)) ids.add(e.value.id);
  // things the typing wiped out come back with the text
  const live = new Set(after.items.map((i) => i.id));
  for (const i of before.items) if (!live.has(i.id)) ids.add(i.id);
  return [...ids].map((id) => putItem.of({ id, item: before.items.find((i) => i.id === id) ?? null }));
});

// ---- the spot the panel is working on, before it has any alternatives ----

export interface Pending { from: number; to: number; unit: Unit }
export const setPending = StateEffect.define<Pending | null>();

export const pendingField = StateField.define<Pending | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPending)) return e.value;
    if (!value) return value;
    if (tr.selection && tr.isUserEvent('select')) return null;
    if (!tr.docChanged) return value;
    const from = tr.changes.mapPos(value.from, 1);
    const to = tr.changes.mapPos(value.to, -1);
    return to > from ? { ...value, from, to } : null;
  },
});

// ---- the choice you're cycling through (lit, and the delete key explodes its option) ----

export const setLit = StateEffect.define<string | null>();

export const litField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLit)) return e.value;
    // anything that moves the cursor (other than cycling, which says so) lets go of the choice
    if (value && (tr.selection || tr.isUserEvent('input') || tr.isUserEvent('delete'))) return null;
    return value;
  },
});

// ---- edit mode ----

let editModeNow = false;
export function setGlobalEditMode(on: boolean): void { editModeNow = on; }
export const setEditMode = StateEffect.define<boolean>();

export const editModeField = StateField.define<boolean>({
  create: () => editModeNow,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setEditMode)) return e.value;
    return value;
  },
});

// ---- a pass's marks: shown until you're done with them, never saved ----

export type MarkType = 'mark' | 'cut' | 'fix';
export interface PassMark { id: string; from: number; to: number; type: MarkType; why: string; fix?: string; kept?: boolean }
export interface PassState {
  passId: string;
  label: string;
  kind: MarkType;
  marks: PassMark[];
  revealAt: number;
  current: string | null;
  /** for a trim: the level it was asked for (10, 20, 30, 50) and the words before */
  level?: number;
  wordsBefore?: number;
}

export const setPass = StateEffect.define<PassState | null>();
export const patchMark = StateEffect.define<{ id: string; patch: Partial<PassMark> | null }>();
export const setCurrentMark = StateEffect.define<string | null>();
/** the fade-in is over */
export const endReveal = StateEffect.define<null>();

export const passField = StateField.define<PassState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setPass)) value = e.value;
      if (e.is(endReveal) && value) value = { ...value, revealAt: 0 };
    }
    if (!value) return value;
    let marks = value.marks;
    let current = value.current;
    if (tr.docChanged) {
      marks = marks.flatMap((m) => {
        const from = tr.changes.mapPos(m.from, 1);
        const to = tr.changes.mapPos(m.to, -1);
        return to > from ? [{ ...m, from, to }] : [];
      });
    }
    for (const e of tr.effects) {
      if (e.is(patchMark)) {
        marks = e.value.patch === null ? marks.filter((m) => m.id !== e.value.id) : marks.map((m) => (m.id === e.value.id ? { ...m, ...e.value.patch } : m));
      }
      if (e.is(setCurrentMark)) current = e.value;
    }
    if (marks === value.marks && current === value.current) return value;
    if (current && !marks.some((m) => m.id === current)) current = null;
    return { ...value, marks, current };
  },
});

export const stateExtensions = [itemsField, undoItems, pendingField, litField, editModeField, passField];
