import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { editorInfoField } from 'obsidian';

import { wantsAn, articleFix, fitCase } from '../src/grammar';
import { wordAt, sentenceAt, paragraphAt, classify, proseBlocks, countBodyWords, sentencesIn } from '../src/text';
import { fromStore, toStore, choiceAt, isChoice, type Choice } from '../src/items';
import { stateExtensions, itemsField, loadItems, litField, setLit } from '../src/state';
import { addAlternatives, setActive, cycle, explodeOption, settle, toggleGhost, targetAt, tidyCut, allOriginal, itemsOf } from '../src/actions';
import { fx } from '../src/fx';
import { parseChunks } from '../src/scratchpad';

fx.sounds = false;
fx.explosions = false;

/** a stand-in for an EditorView: a state, and a dispatch that moves it on */
function editor(doc: string, cursor = 0) {
  let state = EditorState.create({ doc, selection: { anchor: cursor }, extensions: [editorInfoField, history(), stateExtensions] });
  state = state.update({ effects: loadItems.of({ path: 'test.md', items: [] }) }).state;
  const view = {
    get state() { return state; },
    dispatch(...args: Array<Transaction | TransactionSpec>) {
      const tr = args[0] instanceof Transaction ? args[0] : state.update(...(args as TransactionSpec[]));
      state = tr.state;
    },
    focus() {},
  };
  return view as unknown as EditorView & { state: EditorState };
}

const text = (v: EditorView) => v.state.doc.toString();
const only = (v: EditorView): Choice => itemsOf(v.state).filter(isChoice)[0];
const doUndo = (v: EditorView) => undo({ state: v.state, dispatch: (tr) => v.dispatch(tr) });
const doRedo = (v: EditorView) => redo({ state: v.state, dispatch: (tr) => v.dispatch(tr) });
const select = (v: EditorView, from: number, to = from) => v.dispatch({ selection: { anchor: from, head: to } });

// ---- grammar ----

test('a or an', () => {
  for (const w of ['eraser', 'hour', 'honest', 'FBI', 'MRI', 'umbrella', 'unusual', '8-year-old', 'X-ray', 'apple']) assert.equal(wantsAn(w), true, w);
  for (const w of ['thumbtack', 'unicorn', 'university', 'user', 'one-time', 'European', 'NASA', 'house', 'CIA', 'useful']) assert.equal(wantsAn(w), false, w);
});

test('the article before a swap agrees with it', () => {
  const doc = 'I need a thumbtack now.';
  const from = doc.indexOf('thumbtack');
  assert.deepEqual(articleFix(doc, from, 'eraser'), { from: from - 2, to: from - 1, insert: 'an' });
  assert.equal(articleFix(doc, from, 'pencil'), null);
  const cap = 'A thumbtack. ';
  assert.deepEqual(articleFix(cap, 2, 'eraser'), { from: 0, to: 1, insert: 'An' });
  assert.equal(articleFix('banana split', 7, 'eraser'), null);
});

test('a swap at the start of a sentence takes the capital', () => {
  assert.equal(fitCase('Hello. Tension', 7, 'friction', 'Tension'), 'Friction');
  assert.equal(fitCase('Hello. tension', 7, 'friction', 'tension'), 'friction', 'lowercase on purpose stays');
  assert.equal(fitCase('the tension', 4, 'friction', 'tension'), 'friction');
  assert.equal(fitCase('', 0, '"quiet" days', '"Loud" days'), '"Quiet" days');
});

// ---- reading the draft ----

test('words, sentences, paragraphs', () => {
  const doc = '---\ntitle: x\n---\n\n# Heading\n\nThe first one. It\'s the second, isn\'t it? Third!\n\nNext paragraph here.\n- a list item. Two sentences.\n';
  const it = doc.indexOf("It's");
  assert.deepEqual(wordAt(doc, it + 1), { from: it, to: it + 4 });
  const s = sentenceAt(doc, it + 6)!;
  assert.equal(doc.slice(s.from, s.to), "It's the second, isn't it?");
  const p = paragraphAt(doc, it)!;
  assert.equal(doc.slice(p.from, p.to), "The first one. It's the second, isn't it? Third!");
  const li = paragraphAt(doc, doc.indexOf('Two'))!;
  assert.equal(doc.slice(li.from, li.to), 'a list item. Two sentences.');
  assert.equal(paragraphAt(doc, 5), null, 'front matter is not prose');
  const blocks = proseBlocks(doc).map((b) => doc.slice(b.from, b.to));
  assert.deepEqual(blocks, ["The first one. It's the second, isn't it? Third!", 'Next paragraph here.', 'a list item. Two sentences.']);
  assert.equal(sentencesIn(doc, proseBlocks(doc)[0]).length, 3);
  assert.equal(countBodyWords(doc), 18);
});

test('what a selection is', () => {
  const doc = 'One two three. Four five six.\n\nSeven.';
  assert.equal(classify(doc, { from: 0, to: 3 }), 'word');
  assert.equal(classify(doc, { from: 0, to: 7 }), 'phrase');
  assert.equal(classify(doc, { from: 0, to: 14 }), 'sentence');
  assert.equal(classify(doc, { from: 0, to: 29 }), 'paragraph');
});

// ---- choices ----

test('alternatives swap in, cycle round, and fix their article', () => {
  const v = editor('It was a tension, mostly.', 10);
  const t = targetAt(v.state)!;
  assert.equal(text(v).slice(t.from, t.to), 'tension');
  const made = addAlternatives(v, t, [{ text: 'struggle', source: 'human' }, { text: 'uncertainty', source: 'ai', why: 'vaguer' }]);
  assert.ok('choice' in made);
  const c = only(v);
  assert.equal(c.options.length, 3);
  assert.equal(c.active, 0);
  setActive(v, c.id, 2);
  assert.equal(text(v), 'It was an uncertainty, mostly.');
  assert.ok(cycle(v, 1));
  assert.equal(text(v), 'It was a tension, mostly.', 'wraps round to the original');
  assert.ok(cycle(v, -1));
  assert.equal(text(v), 'It was an uncertainty, mostly.');
  assert.equal(v.state.field(litField), c.id, 'cycling lights the choice');
});

test('your own alternative shows itself right away', () => {
  const v = editor('Make it pop.', 8);
  const made = addAlternatives(v, targetAt(v.state)!, [{ text: 'sing', source: 'human' }], true);
  assert.ok('choice' in made);
  assert.equal(text(v), 'Make it sing.');
  assert.equal(only(v).active, 1);
});

test('exploding an option: the next slides in, and ⌘Z brings it back', () => {
  const v = editor('A deep business.', 3);
  addAlternatives(v, targetAt(v.state)!, [{ text: 'quiet', source: 'ai' }, { text: 'slow', source: 'ai' }, { text: 'real', source: 'human' }]);
  const c = only(v);
  setActive(v, c.id, 1);
  assert.equal(text(v), 'A quiet business.');
  assert.equal(explodeOption(v, c.id, 1), 'gone');
  assert.equal(text(v), 'A slow business.');
  assert.deepEqual(only(v).options.map((o) => o.text), ['deep', 'slow', 'real']);
  doUndo(v);
  assert.equal(text(v), 'A quiet business.');
  assert.deepEqual(only(v).options.map((o) => o.text), ['deep', 'quiet', 'slow', 'real']);
  assert.equal(only(v).active, 1);
  doRedo(v);
  assert.equal(text(v), 'A slow business.');
  assert.equal(explodeOption(v, c.id, 0), 'original', 'the original never explodes');
});

test('the last option explodes back to the one before it', () => {
  const v = editor('So good.', 4);
  addAlternatives(v, targetAt(v.state)!, [{ text: 'great', source: 'ai' }]);
  const c = only(v);
  setActive(v, c.id, 1);
  explodeOption(v, c.id, 1);
  assert.equal(text(v), 'So good.');
  assert.equal(only(v).options.length, 1);
});

test('cycling is undoable, one swap at a time', () => {
  const v = editor('the tension here', 6);
  addAlternatives(v, targetAt(v.state)!, [{ text: 'pressure', source: 'human' }, { text: 'friction', source: 'ai' }]);
  cycle(v, 1);
  cycle(v, 1);
  assert.equal(text(v), 'the friction here');
  doUndo(v);
  assert.equal(text(v), 'the pressure here');
  assert.equal(only(v).active, 1);
});

test('typing inside a choice rewrites the option you are on; carrying on a word grows it', () => {
  const v = editor('a struggle today', 4);
  addAlternatives(v, targetAt(v.state)!, [{ text: 'fight', source: 'human' }]);
  const c = only(v);
  v.dispatch({ changes: { from: c.to, insert: 's' }, userEvent: 'input.type' });
  assert.equal(only(v).options[0].text, 'struggles');
  v.dispatch({ changes: { from: only(v).to, insert: ' ' }, userEvent: 'input.type' });
  assert.equal(only(v).options[0].text, 'struggles', 'a space stays outside');
});

test('deleting all of a choice lets it go; ⌘Z brings it back with its options', () => {
  const v = editor('one two three', 5);
  addAlternatives(v, targetAt(v.state)!, [{ text: 'deux', source: 'human' }]);
  const c = only(v);
  v.dispatch({ changes: { from: c.from - 1, to: c.to }, userEvent: 'delete' });
  assert.equal(itemsOf(v.state).length, 0);
  doUndo(v);
  assert.equal(text(v), 'one two three');
  assert.deepEqual(only(v).options.map((o) => o.text), ['two', 'deux']);
});

test('a word choice inside a sentence choice is tucked away and comes back', () => {
  const doc = 'The work is hard. Then rest.';
  const v = editor(doc, 13);
  // the word first
  addAlternatives(v, targetAt(v.state, 'word')!, [{ text: 'brutal', source: 'ai' }]);
  const word = only(v);
  setActive(v, word.id, 1);
  assert.equal(text(v), 'The work is brutal. Then rest.');
  // then the sentence around it
  select(v, 0, 19);
  const s = targetAt(v.state)!;
  assert.equal(s.unit, 'sentence');
  addAlternatives(v, s, [{ text: 'Work hurts.', source: 'ai' }]);
  const sentence = itemsOf(v.state).filter(isChoice).find((c) => c.unit === 'sentence')!;
  setActive(v, sentence.id, 1);
  assert.equal(text(v), 'Work hurts. Then rest.');
  assert.equal(itemsOf(v.state).filter(isChoice).length, 1, 'the word choice is tucked into the outgoing sentence');
  setActive(v, sentence.id, 0);
  assert.equal(text(v), 'The work is brutal. Then rest.');
  const back = itemsOf(v.state).filter(isChoice).find((c) => c.unit === 'word')!;
  assert.ok(back, 'the word choice is back');
  assert.equal(text(v).slice(back.from, back.to), 'brutal');
  setActive(v, back.id, 0);
  assert.equal(text(v), 'The work is hard. Then rest.');
  const outer = itemsOf(v.state).filter(isChoice).find((c) => c.unit === 'sentence')!;
  assert.equal(text(v).slice(outer.from, outer.to), 'The work is hard.', 'the sentence follows the word inside it');
});

test('a word at the very start of a sentence choice swaps without the sentence losing it', () => {
  const v = editor('Struggle is good. Yes.', 2);
  select(v, 0, 17);
  addAlternatives(v, targetAt(v.state)!, [{ text: 'It is fine.', source: 'ai' }]);
  select(v, 2);
  addAlternatives(v, targetAt(v.state, 'word')!, [{ text: 'friction', source: 'human' }], true);
  assert.equal(text(v), 'Friction is good. Yes.');
  const outer = itemsOf(v.state).filter(isChoice).find((c) => c.unit === 'sentence')!;
  assert.equal(text(v).slice(outer.from, outer.to), 'Friction is good.');
});

test('settling keeps what shows and drops the rest', () => {
  const v = editor('very nice', 6);
  addAlternatives(v, targetAt(v.state)!, [{ text: 'kind', source: 'ai' }], true);
  settle(v, only(v).id);
  assert.equal(text(v), 'very kind');
  assert.equal(itemsOf(v.state).length, 0);
  doUndo(v);
  assert.equal(only(v).options.length, 2);
});

test('every choice back to the original', () => {
  const v = editor('red fish blue fish', 1);
  addAlternatives(v, targetAt(v.state)!, [{ text: 'green', source: 'ai' }], true);
  select(v, v.state.doc.toString().indexOf('blue') + 1);
  addAlternatives(v, targetAt(v.state)!, [{ text: 'gold', source: 'ai' }], true);
  assert.equal(text(v), 'green fish gold fish');
  assert.equal(allOriginal(v), 2);
  assert.equal(text(v), 'red fish blue fish');
});

// ---- ghosts ----

test('ghosting a selection, and bringing it back', () => {
  const v = editor('Keep this. Maybe not this. Keep.', 0);
  select(v, 11, 26);
  assert.equal(toggleGhost(v), 'ghosted');
  const g = itemsOf(v.state)[0];
  assert.equal(g.kind, 'ghost');
  assert.equal(text(v).slice(g.from, g.to), 'Maybe not this.');
  select(v, 14);
  assert.equal(toggleGhost(v), 'back');
  assert.equal(itemsOf(v.state).length, 0);
  doUndo(v);
  assert.equal(itemsOf(v.state).length, 1);
});

// ---- saving ----

test('saved choices find their words again after the note moved around', () => {
  const v = editor('alpha beta gamma', 7);
  addAlternatives(v, targetAt(v.state)!, [{ text: 'BETA', source: 'human' }]);
  const stored = JSON.parse(JSON.stringify(toStore(itemsOf(v.state))));
  const moved = 'new words first. alpha beta gamma';
  const items = fromStore(stored, moved);
  assert.equal(items.length, 1);
  assert.equal(moved.slice(items[0].from, items[0].to), 'beta');
  assert.equal(fromStore(stored, 'nothing like it').length, 0);
  assert.equal(toStore([]), null);
});

test('a choice with nothing but its original is not worth saving', () => {
  const v = editor('plain', 2);
  addAlternatives(v, targetAt(v.state)!, []);
  assert.equal(toStore(itemsOf(v.state)), null);
});

test('the whole note replaced (a reload): items re-find their text', () => {
  const v = editor('one two three', 5);
  addAlternatives(v, targetAt(v.state)!, [{ text: 'deux', source: 'human' }]);
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'zero one two three' } });
  const c = only(v);
  assert.equal(text(v).slice(c.from, c.to), 'two');
});

// ---- cuts and scratchpads ----

test('cuts leave clean spaces', () => {
  const doc = 'It is really very good.';
  const r = doc.indexOf('really');
  const cut = tidyCut(doc, r, r + 6);
  assert.equal(doc.slice(0, cut.from) + doc.slice(cut.to), 'It is very good.');
  const g = doc.indexOf('good');
  const cut2 = tidyCut(doc, g - 5, g + 4);
  assert.equal(doc.slice(0, cut2.from) + doc.slice(cut2.to), 'It is really.');
  const job = 'the whole job, honestly.';
  const h = job.indexOf('honestly');
  const cut3 = tidyCut(job, h, h + 8);
  assert.equal(job.slice(0, cut3.from) + job.slice(cut3.to), 'the whole job.');
});

test('scratchpad chunks', () => {
  const content = '---\nscratchpad-for: "[[Draft]]"\n---\n\n%% stashed 2026-11-03 22:42 %%\nfirst bit\n\n%% stashed 2026-11-03 22:50 %%\nsecond\nbit\n';
  const chunks = parseChunks(content);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'first bit');
  assert.equal(chunks[1].text, 'second\nbit');
  assert.equal(chunks[1].when, '2026-11-03 22:50');
});

test('lit clears when you move', () => {
  const v = editor('a b c', 0);
  v.dispatch({ effects: setLit.of('x') });
  v.dispatch({ selection: { anchor: 3 }, userEvent: 'select' });
  assert.equal(v.state.field(litField), null);
  assert.equal(choiceAt(itemsOf(v.state), 0), null);
  assert.ok(v.state.field(itemsField).loaded);
});
