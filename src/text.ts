/**
 * Reading the draft: words, sentences, paragraphs, and where the prose actually is.
 * Pure functions over a string, so they're easy to test and cheap to run on every cursor move.
 */

export type Unit = 'word' | 'phrase' | 'sentence' | 'paragraph';
export interface Span { from: number; to: number }

const WORD_CHAR = /[\p{L}\p{N}'’-]/u;
const EDGE_JUNK = /['’-]/;

/** where the body starts: just past the front matter, if there is any */
export function frontmatterEnd(text: string): number {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? m[0].length : 0;
}

export function countWords(text: string, from = 0, to = text.length): number {
  const m = text.slice(from, to).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

export function countBodyWords(text: string): number {
  return countWords(text, frontmatterEnd(text));
}

export function isWordChar(ch: string | undefined): boolean {
  return !!ch && WORD_CHAR.test(ch);
}

/** the word the cursor is in (or touching) */
export function wordAt(text: string, pos: number): Span | null {
  let from = pos;
  let to = pos;
  while (from > 0 && WORD_CHAR.test(text[from - 1])) from--;
  while (to < text.length && WORD_CHAR.test(text[to])) to++;
  while (from < to && EDGE_JUNK.test(text[from])) from++;
  while (to > from && EDGE_JUNK.test(text[to - 1])) to--;
  return to > from ? { from, to } : null;
}

/** a span without the whitespace at its ends */
export function trimSpan(text: string, span: Span): Span {
  let { from, to } = span;
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return { from, to };
}

// ---- lines and blocks ----

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE = /^\s*\|/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(\[.\]\s+)?/;
const QUOTE = /^\s*>\s?/;
const CALLOUT = /^\s*>\s?\[![^\]]*\]/;
const EMBED_ONLY = /^\s*!\[\[[^\]]*\]\]\s*$/;

interface Line { from: number; to: number; text: string }

function linesOf(text: string, from: number, to: number): Line[] {
  const out: Line[] = [];
  let start = from;
  while (start <= to) {
    let end = text.indexOf('\n', start);
    if (end === -1 || end > to) end = to;
    out.push({ from: start, to: end, text: text.slice(start, end) });
    if (end >= to) break;
    start = end + 1;
  }
  return out;
}

/**
 * The prose in the draft, as blocks: paragraphs, list items, quote lines.
 * Front matter, code, headings, rules, tables and lone embeds are left out:
 * the passes read prose, not scaffolding.
 */
export function proseBlocks(text: string, from = 0, to = text.length): Span[] {
  const start = Math.max(from, frontmatterEnd(text));
  const blocks: Span[] = [];
  let open: Span | null = null;
  let inCode = false;
  const flush = () => { if (open) { const t = trimSpan(text, open); if (t.to > t.from) blocks.push(t); } open = null; };

  for (const line of linesOf(text, start, Math.max(start, to))) {
    if (FENCE.test(line.text)) { flush(); inCode = !inCode; continue; }
    if (inCode) continue;
    if (!line.text.trim() || HEADING.test(line.text) || RULE.test(line.text) || TABLE.test(line.text) || EMBED_ONLY.test(line.text) || CALLOUT.test(line.text)) {
      flush();
      continue;
    }
    const list = LIST.exec(line.text);
    const quote = QUOTE.exec(line.text);
    if (list || quote) {
      flush();
      const skip = (list ?? quote)![0].length;
      open = { from: line.from + skip, to: line.to };
      flush(); // each list item or quote line is its own block
      continue;
    }
    if (open) open.to = line.to; else open = { from: line.from, to: line.to };
  }
  flush();
  return blocks;
}

type Segmenter = { segment(s: string): Iterable<{ segment: string; index: number }> };
let segmenter: Segmenter | null | undefined;
function getSegmenter(): Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  const Intl_ = Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => Segmenter };
  segmenter = Intl_.Segmenter ? new Intl_.Segmenter('en', { granularity: 'sentence' }) : null;
  return segmenter;
}

/** the sentences in a block, as spans of the whole text */
export function sentencesIn(text: string, block: Span): Span[] {
  const s = text.slice(block.from, block.to);
  const out: Span[] = [];
  const seg = getSegmenter();
  if (seg) {
    for (const part of seg.segment(s)) {
      const span = trimSpan(text, { from: block.from + part.index, to: block.from + part.index + part.segment.length });
      if (span.to > span.from) out.push(span);
    }
  } else {
    const re = /[^.!?]+(?:[.!?]+["'”’)\]]*|$)\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) && m[0]) {
      const span = trimSpan(text, { from: block.from + m.index, to: block.from + m.index + m[0].length });
      if (span.to > span.from) out.push(span);
    }
  }
  return out;
}

/** the paragraph around a position: the run of non-blank lines, minus a list/quote/heading marker */
export function paragraphAt(text: string, pos: number): Span | null {
  if (pos < frontmatterEnd(text)) return null;
  const lineStartOf = (p: number) => text.lastIndexOf('\n', p - 1) + 1;
  const lineEndOf = (p: number) => { const i = text.indexOf('\n', p); return i === -1 ? text.length : i; };
  const breaks = (line: string) => !line.trim() || LIST.test(line) || HEADING.test(line) || FENCE.test(line)
    || QUOTE.test(line) || RULE.test(line) || TABLE.test(line);

  let from = lineStartOf(pos);
  let to = lineEndOf(pos);
  const current = text.slice(from, to);
  if (!current.trim()) return null;
  // list items, headings and quote lines stand alone; a plain paragraph runs until a blank line or a block
  if (!LIST.test(current) && !HEADING.test(current) && !QUOTE.test(current)) {
    while (from > 0) {
      const prevStart = lineStartOf(from - 1);
      if (breaks(text.slice(prevStart, from - 1))) break;
      from = prevStart;
    }
    while (to < text.length) {
      const nextEnd = lineEndOf(to + 1);
      if (breaks(text.slice(to + 1, nextEnd))) break;
      to = nextEnd;
    }
  }
  const first = text.slice(from, lineEndOf(from));
  const marker = LIST.exec(first) ?? QUOTE.exec(first) ?? /^\s{0,3}#{1,6}\s+/.exec(first);
  if (marker) from += marker[0].length;
  const span = trimSpan(text, { from, to });
  return span.to > span.from ? span : null;
}

/** the sentence around a position */
export function sentenceAt(text: string, pos: number): Span | null {
  const para = paragraphAt(text, pos);
  if (!para) return null;
  const sentences = sentencesIn(text, para);
  let best: Span | null = null;
  for (const s of sentences) {
    if (pos >= s.from && pos <= s.to) return s;
    if (s.from <= pos) best = s;
  }
  return best ?? sentences[0] ?? null;
}

export function spanFor(text: string, pos: number, unit: Unit): Span | null {
  if (unit === 'word') return wordAt(text, pos);
  if (unit === 'sentence') return sentenceAt(text, pos);
  if (unit === 'paragraph') return paragraphAt(text, pos);
  return null;
}

/** what kind of thing a selection is: a word, a phrase, a sentence, or a paragraph (or more) */
export function classify(text: string, span: Span): Unit {
  const t = text.slice(span.from, span.to).trim();
  if (!/\s/.test(t)) return 'word';
  if (/\n\s*\n/.test(t)) return 'paragraph';
  const para = paragraphAt(text, span.from);
  if (para && span.from <= para.from && span.to >= para.to) return 'paragraph';
  if (para) {
    const sentences = sentencesIn(text, para);
    if (sentences.length > 1 && sentences.filter((s) => s.from >= span.from && s.to <= span.to).length > 1) return 'paragraph';
    if (sentences.some((s) => s.from === span.from && s.to === span.to) || /[.!?]["'”’)\]]*$/.test(t)) return 'sentence';
  }
  return 'phrase';
}

export const UNIT_LABEL: Record<Unit, string> = { word: 'Word', phrase: 'Phrase', sentence: 'Sentence', paragraph: 'Paragraph' };
