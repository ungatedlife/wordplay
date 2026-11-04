/**
 * What edit mode looks like and how it answers the keyboard and the mouse, inside the editor:
 * the pen underlines, ghosts, the lit choice, a pass's marks, ⌥←/→ to cycle, ⌫ to explode,
 * right-click for the edit menu, and a little overlay at the bottom (the passes chip, a pass's results).
 */
import { Prec, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, hoverTooltip, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type WordplayPlugin from './main';
import { choiceAt, choiceById, ghostAt } from './items';
import { cycle, explodeOption, itemsOf } from './actions';
import { editModeField, endReveal, itemsField, litField, passField, pendingField, setLit, stateExtensions, type PassMark } from './state';
import { shake } from './fx';

// ---- looks ----

class FixWidget extends WidgetType {
  constructor(readonly fix: string, readonly id: string) { super(); }
  eq(other: FixWidget): boolean { return other.fix === this.fix && other.id === this.id; }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'wp-fix';
    el.dataset.wpMark = this.id;
    el.textContent = this.fix || '∅';
    return el;
  }
  ignoreEvent(): boolean { return false; }
}

function decorate(state: EditorView['state']): DecorationSet {
  if (!state.field(editModeField, false)) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  const items = state.field(itemsField, false)?.items ?? [];
  const lit = state.field(litField, false);
  const doc = state.doc;

  for (const item of items) {
    if (item.kind === 'ghost') {
      ranges.push(Decoration.mark({ class: 'wp-ghost', attributes: { 'data-wp-ghost': item.id } }).range(item.from, item.to));
      continue;
    }
    if (item.options.length < 2 && lit !== item.id) continue;
    const source = item.options[item.active]?.source ?? 'original';
    const cls = `wp-choice wp-src-${source} wp-unit-${item.unit}${lit === item.id ? ' wp-lit' : ''}`;
    ranges.push(Decoration.mark({ class: cls, attributes: { 'data-wp-choice': item.id } }).range(item.from, item.to));
    if (item.unit === 'paragraph') {
      // a paragraph's alternatives get a pen stroke down the margin instead of a page of underline
      const first = doc.lineAt(item.from).number;
      const last = doc.lineAt(item.to).number;
      for (let n = first; n <= last; n++) {
        const line = doc.line(n);
        if (!line.text.trim()) continue;
        ranges.push(Decoration.line({ class: `wp-para wp-src-${source}${lit === item.id ? ' wp-lit' : ''}` }).range(line.from));
      }
    }
  }

  const pending = state.field(pendingField, false);
  if (pending) ranges.push(Decoration.mark({ class: 'wp-pending' }).range(pending.from, pending.to));

  const pass = state.field(passField, false);
  if (pass) {
    const reveal = pass.revealAt > 0;
    pass.marks.forEach((m, i) => {
      const cls = ['wp-mark', `wp-mark-${m.type}`, m.kept ? 'wp-kept' : '', pass.current === m.id ? 'wp-current' : '', reveal ? 'wp-reveal' : ''].filter(Boolean).join(' ');
      const attributes: Record<string, string> = { 'data-wp-mark': m.id };
      if (reveal) attributes.style = `animation-delay: ${Math.min(i * 45, 900)}ms`;
      ranges.push(Decoration.mark({ class: cls, attributes }).range(m.from, m.to));
      if (m.type === 'fix') ranges.push(Decoration.widget({ widget: new FixWidget(m.fix ?? '', m.id), side: 1 }).range(m.to));
    });
  }
  return Decoration.set(ranges, true);
}

const decorations = EditorView.decorations.compute([itemsField, pendingField, litField, editModeField, passField], decorate);

// ---- the overlay: the passes chip, a pass's results, the scanner ----

export class Overlay {
  readonly root: HTMLElement;
  readonly chip: HTMLElement;
  readonly scanner: HTMLElement;
  bar: HTMLElement | null = null;
  card: HTMLElement | null = null;

  constructor(readonly view: EditorView, private plugin: WordplayPlugin) {
    this.root = view.dom.createDiv({ cls: 'wp-overlay' });
    this.scanner = view.dom.createDiv({ cls: 'wp-scanner' });
    this.chip = this.root.createEl('button', { cls: 'wp-chip', text: 'passes' });
    this.chip.setAttr('aria-label', 'Passes: mark, fix and trim');
    this.chip.addEventListener('mousedown', (e) => e.preventDefault());
    this.chip.addEventListener('click', () => plugin.openPasses(view));
    this.sync();
  }

  sync(): void {
    const on = this.view.state.field(editModeField, false) ?? false;
    this.root.toggleClass('is-on', on);
    this.chip.toggleClass('is-hidden', !!this.bar);
  }

  scanning(on: boolean): void {
    this.scanner.toggleClass('is-scanning', on);
    this.view.dom.toggleClass('wp-is-scanning', on);
  }

  /** the results bar (null takes it away) */
  setBar(build: ((el: HTMLElement) => void) | null): HTMLElement | null {
    this.bar?.remove();
    this.bar = null;
    if (build) {
      this.bar = this.root.createDiv({ cls: 'wp-bar' });
      build(this.bar);
    }
    this.sync();
    return this.bar;
  }

  setCard(card: HTMLElement | null): void {
    if (this.card && this.card !== card) this.card.remove();
    this.card = card;
  }

  destroy(): void {
    this.root.remove();
    this.scanner.remove();
    this.card?.remove();
    this.view.dom.removeClass('wp-is-scanning');
  }
}

const overlays = new WeakMap<EditorView, Overlay>();
export function overlayFor(view: EditorView): Overlay | null { return overlays.get(view) ?? null; }

// ---- the bridge: loads and saves a note's choices, keeps the panel in step ----

function bridge(plugin: WordplayPlugin) {
  return ViewPlugin.fromClass(class {
    overlay: Overlay;
    loading: string | null = null;
    revealTimer = 0;

    constructor(readonly view: EditorView) {
      plugin.views.add(view);
      this.overlay = new Overlay(view, plugin);
      overlays.set(view, this.overlay);
      this.maybeLoad();
    }

    maybeLoad(): void {
      const s = this.view.state.field(itemsField, false);
      if (!s || s.loaded || !s.path || this.loading === s.path) return;
      const path = s.path;
      this.loading = path;
      window.setTimeout(() => {
        this.loading = null;
        const now = this.view.state.field(itemsField, false);
        if (now && !now.loaded && now.path === path) plugin.loadInto(this.view, path);
      }, 0);
    }

    update(u: ViewUpdate): void {
      const before = u.startState.field(itemsField, false);
      const after = u.state.field(itemsField, false);
      if (after && !after.loaded) this.maybeLoad();
      if (before && after && after.loaded && after.path && before.path === after.path && before.items !== after.items) {
        plugin.persist(after.path, after.items);
      }
      if (u.startState.field(editModeField, false) !== u.state.field(editModeField, false)) this.overlay.sync();
      if (u.docChanged || u.selectionSet || before?.items !== after?.items || u.startState.field(pendingField, false) !== u.state.field(pendingField, false)) {
        plugin.editorChanged(this.view);
      }
      // a pass's marks fade in once; after that the class comes off so redraws don't replay it
      const pass = u.state.field(passField, false);
      if (pass && pass.revealAt && !this.revealTimer) {
        this.revealTimer = window.setTimeout(() => {
          this.revealTimer = 0;
          if (this.view.state.field(passField, false)?.revealAt) this.view.dispatch({ effects: endReveal.of(null) });
        }, 1500);
      }
    }

    destroy(): void {
      plugin.views.delete(this.view);
      window.clearTimeout(this.revealTimer);
      this.overlay.destroy();
      overlays.delete(this.view);
    }
  });
}

// ---- keys ----

type Combo = 'alt' | 'ctrl-alt' | 'ctrl';

function keys(plugin: WordplayPlugin): Extension {
  const cycleKey = (combo: Combo, dir: 1 | -1) => (view: EditorView): boolean => {
    if (!view.state.field(editModeField, false) || plugin.settings.cycleKeys !== combo) return false;
    return cycle(view, dir);
  };
  const explodeKey = (view: EditorView): boolean => {
    if (!view.state.field(editModeField, false)) return false;
    const lit = choiceById(itemsOf(view.state), view.state.field(litField, false));
    if (!lit || !view.state.selection.main.empty) return false;
    const r = explodeOption(view, lit.id, lit.active);
    if (r === 'original') shake(view.contentDOM.querySelector<HTMLElement>(`[data-wp-choice="${lit.id}"]`));
    return r !== 'missing';
  };
  return Prec.highest(keymap.of([
    { key: 'Alt-ArrowRight', run: cycleKey('alt', 1) },
    { key: 'Alt-ArrowLeft', run: cycleKey('alt', -1) },
    { key: 'Ctrl-Alt-ArrowRight', run: cycleKey('ctrl-alt', 1) },
    { key: 'Ctrl-Alt-ArrowLeft', run: cycleKey('ctrl-alt', -1) },
    { key: 'Ctrl-ArrowRight', run: cycleKey('ctrl', 1) },
    { key: 'Ctrl-ArrowLeft', run: cycleKey('ctrl', -1) },
    { key: 'Backspace', run: explodeKey },
    { key: 'Delete', run: explodeKey },
    {
      key: 'Escape',
      run: (view) => {
        if (!view.state.field(litField, false)) return false;
        view.dispatch({ effects: setLit.of(null) });
        return true;
      },
    },
  ]));
}

// ---- the mouse ----

function markAt(view: EditorView, pos: number): PassMark | null {
  return view.state.field(passField, false)?.marks.find((m) => pos >= m.from && pos <= m.to) ?? null;
}

function mouse(plugin: WordplayPlugin): Extension {
  return Prec.highest(EditorView.domEventHandlers({
    contextmenu(event, view) {
      if (!view.state.field(editModeField, false)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const sel = view.state.selection.main;
      const inSelection = !sel.empty && pos !== null && pos >= sel.from && pos <= sel.to;
      const items = itemsOf(view.state);
      const onSomething = pos !== null && (!!choiceAt(items, pos) || !!ghostAt(items, pos) || !!markAt(view, pos));
      if (!inSelection && !onSomething) return false;
      event.preventDefault();
      event.stopPropagation();
      if (!inSelection && pos !== null) view.dispatch({ selection: { anchor: pos } });
      plugin.openEditMenu(view, { x: event.clientX, y: event.clientY });
      return true;
    },
    // a click on a mark (by where you clicked: the mark's element may be redrawn mid-click)
    mouseup(event, view) {
      if (!view.state.field(editModeField, false) || event.button !== 0 || event.shiftKey || event.metaKey) return false;
      if (!view.state.field(passField, false)) return false;
      const widget = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-wp-mark]');
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const marks = view.state.field(passField, false)?.marks ?? [];
      const mark = widget ? marks.find((m) => m.id === widget.dataset.wpMark) : pos === null ? null : marks.find((m) => pos > m.from && pos < m.to) ?? null;
      if (!mark) return false;
      window.setTimeout(() => {
        if (view.state.selection.main.empty) plugin.passes.clickMark(view, mark);
      }, 0);
      return false;
    },
  }));
}

// ---- hover: why a mark is there, what a choice holds ----

function hovers(plugin: WordplayPlugin): Extension {
  return hoverTooltip((view, pos) => {
    if (!view.state.field(editModeField, false)) return null;
    const mark = markAt(view, pos);
    if (mark) {
      return {
        pos: mark.from, end: mark.to, above: true,
        create: () => {
          const dom = createDiv({ cls: 'wp-tip' });
          if (mark.type === 'fix') dom.createDiv({ cls: 'wp-tip-fix', text: `→ ${mark.fix || '(nothing)'}` });
          if (mark.why) dom.createDiv({ cls: 'wp-tip-why', text: mark.why });
          dom.createDiv({ cls: 'wp-tip-hint', text: mark.type === 'cut' ? (mark.kept ? 'kept. click to cut it again.' : 'click to keep it.') : 'click for what you can do.' });
          return { dom };
        },
      };
    }
    const choice = choiceAt(itemsOf(view.state), pos);
    if (!choice || choice.options.length < 2) return null;
    return {
      pos: choice.from, end: choice.to, above: true,
      create: () => {
        const dom = createDiv({ cls: 'wp-tip' });
        const ai = choice.options.filter((o) => o.source === 'ai').length;
        const yours = choice.options.length - 1 - ai;
        const parts = [yours ? `${yours} yours` : '', ai ? `${ai} AI` : ''].filter(Boolean).join(' · ');
        dom.createDiv({ cls: 'wp-tip-why', text: `${choice.options.length - 1} alternative${choice.options.length === 2 ? '' : 's'} (${parts})` });
        dom.createDiv({ cls: 'wp-tip-hint', text: `${plugin.cycleHint()} to try them` });
        return { dom };
      },
    };
  }, { hoverTime: 450 });
}

export function editorExtension(plugin: WordplayPlugin): Extension[] {
  return [stateExtensions, decorations, bridge(plugin), keys(plugin), mouse(plugin), hovers(plugin)];
}
