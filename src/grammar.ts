/**
 * The small grammar that makes a swap slot in: "a thumbtack" becomes "an eraser",
 * and a word that starts a sentence keeps its capital.
 */

const A_DESPITE_VOWEL = /^(unique|unit|union|unicorn|univers|uniform|unilateral|unison|unif|unanim|use|usu|user|usab|uti|utop|ure|uri|euro|eu|ewe|one\b|one-|once|ufo|ubiq|uk\b|us\b)/;
const AN_DESPITE_CONSONANT = /^(hour|honest|honou?r|heir)/;
const LETTER_NAME_VOWEL = /^[aefhilmnorsx]/i; // "an FBI agent", "an MBA", "an X-ray"
// acronyms said as words take the word's sound: "a NASA launch", "an OPEC deal"
const SPOKEN_ACRONYM = /^(NASA|NATO|UNICEF|UNESCO|OPEC|SCOTUS|FOMO|YOLO|GIF|JPEG|LASER|RADAR|SCUBA|SIM|PIN|ASAP|AIDS|ROI|SaaS)$/;

/** does this word take "an"? */
export function wantsAn(word: string): boolean {
  if (!word) return false;
  if (/^\d/.test(word)) return /^8/.test(word) || /^1[18](\D|$)/.test(word) || /^1[18]\d{2}(\D|$)/.test(word);
  // initialisms are read letter by letter: an FBI, a CIA, an MRI, an X-ray
  if (/^[A-Z]{2,5}s?$/.test(word) && !SPOKEN_ACRONYM.test(word)) return LETTER_NAME_VOWEL.test(word);
  if (/^[A-Z]-/.test(word)) return LETTER_NAME_VOWEL.test(word);
  const w = word.toLowerCase();
  if (AN_DESPITE_CONSONANT.test(w)) return true;
  if (A_DESPITE_VOWEL.test(w)) return false;
  return /^[aeiou]/.test(w);
}

/** the first real word of some text, past quotes, brackets and markdown emphasis */
export function firstWord(text: string): string {
  const m = /^[\s"'“‘(\[*_~]*([\p{L}\p{N}][\p{L}\p{N}'’-]*)/u.exec(text);
  return m ? m[1] : '';
}

export interface Change { from: number; to: number; insert: string }

/**
 * If an "a" or "an" sits right before `from`, the change that makes it agree with `next`
 * (null when it already does, or there's no article).
 */
export function articleFix(doc: string, from: number, next: string): Change | null {
  let p = from;
  while (p > 0 && /[ \t*_]/.test(doc[p - 1])) p--;
  if (p === from) return null; // the article has to be its own word, with a space before the swap
  let start = p;
  while (start > 0 && /[A-Za-z]/.test(doc[start - 1])) start--;
  const article = doc.slice(start, p);
  if (!/^(a|an)$/i.test(article)) return null;
  if (start > 0 && /[\p{L}\p{N}]/u.test(doc[start - 1])) return null;
  const word = firstWord(next);
  if (!word) return null;
  let want = wantsAn(word) ? 'an' : 'a';
  if (article[0] === 'A') want = want === 'an' ? 'An' : 'A';
  if (article === 'AN' || (article === 'A' && /^[A-Z]{2,}$/.test(doc.slice(p, p + 2)))) want = want.toUpperCase();
  return want === article ? null : { from: start, to: p, insert: want };
}

/** is `pos` where a sentence starts: the top of a paragraph or line item, or after . ! ? */
export function isSentenceStart(doc: string, pos: number): boolean {
  let p = pos;
  while (p > 0 && /[ \t"'“‘(\[*_]/.test(doc[p - 1])) p--;
  if (p === 0) return true;
  const ch = doc[p - 1];
  if (ch === '\n') return true;
  if (/[.!?]/.test(ch)) return true;
  // a list marker, quote marker or heading marker right before
  const lineStart = doc.lastIndexOf('\n', p - 1) + 1;
  return /^\s*([-*+]|\d+[.)]|>|#{1,6})\s*$/.test(doc.slice(lineStart, p));
}

/**
 * A swap at the start of a sentence starts with a capital, if the original did.
 * (Lowercase on purpose stays lowercase.)
 */
export function fitCase(doc: string, from: number, insert: string, original: string): string {
  if (!/^[^\p{L}]*\p{Lu}/u.test(original) || !isSentenceStart(doc, from)) return insert;
  const m = /^([\s"'“‘(\[*_~]*)(\p{Ll})/u.exec(insert);
  if (!m) return insert;
  return m[1] + m[2].toUpperCase() + insert.slice(m[0].length);
}
