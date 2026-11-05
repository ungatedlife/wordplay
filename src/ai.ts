/**
 * Talking to a model through OpenRouter. Two brains:
 *   quick  (dumb mode)          word swaps, typos, the mechanical passes: cheap and fast
 *   smart  (smarty pants mode)  anything a sentence or longer, trims, the judgment calls
 */
import { requestUrl } from 'obsidian';
import type WordplayPlugin from './main';
import type { Unit } from './text';

export type Brain = 'quick' | 'smart';

export class AiError extends Error {
  constructor(message: string, readonly hint = '') { super(message); }
}

interface Message { role: 'system' | 'user' | 'assistant'; content: string }

export async function chat(plugin: WordplayPlugin, brain: Brain, messages: Message[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
  const s = plugin.settings;
  const model = (brain === 'smart' ? s.smartModel : s.quickModel).trim();
  if (!model) throw new AiError(`no ${brain} model set`, 'Pick one in Settings → Wordplay.');
  const key = plugin.apiKey();
  const base = (s.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  if (!key && base.includes('openrouter.ai')) throw new AiError('no OpenRouter key yet', 'Add it in Settings → Wordplay.');

  let res;
  try {
    res = await requestUrl({
      url: `${base}/chat/completions`,
      method: 'POST',
      contentType: 'application/json',
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        'HTTP-Referer': 'https://github.com/ungatedlife/wordplay',
        'X-Title': 'Wordplay',
      },
      body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.8, max_tokens: opts.maxTokens ?? 1500 }),
      throw: false,
    });
  } catch (e) {
    throw new AiError("couldn't reach OpenRouter", (e as Error).message);
  }
  if (res.status >= 400) {
    let detail = '';
    try { detail = res.json?.error?.message ?? ''; } catch { detail = res.text?.slice(0, 200) ?? ''; }
    if (res.status === 401) throw new AiError("OpenRouter didn't take the key", 'Check it in Settings → Wordplay.');
    if (res.status === 402) throw new AiError("OpenRouter's out of credits", detail);
    if (res.status === 404 || res.status === 400) throw new AiError(`the ${brain} model said no (${model})`, detail);
    if (res.status === 429) throw new AiError('too many asks at once', 'Give it a few seconds.');
    throw new AiError(`OpenRouter error ${res.status}`, detail);
  }
  const msg = res.json?.choices?.[0]?.message;
  const content = typeof msg?.content === 'string' ? msg.content
    : Array.isArray(msg?.content) ? msg.content.map((p: { text?: string }) => p.text ?? '').join('') : '';
  if (!content.trim()) throw new AiError('the model came back empty', model);
  return content;
}

/** the JSON in a reply, even wrapped in prose or a code fence */
export function parseJson<T>(raw: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.search(/[{[]/);
  if (start === -1) throw new AiError("the model didn't answer in JSON", raw.slice(0, 120));
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    throw new AiError("couldn't read the model's answer", raw.slice(0, 120));
  }
}

// ---- alternatives ----

export interface AltContext {
  title: string;
  before: string;
  target: string;
  after: string;
  unit: Unit;
  existing: string[];
  steer?: string;
}

export interface AltIdea { text: string; why?: string }

const ALT_SYSTEM = `You help a writer play with alternatives in their own draft. You suggest; they choose.

It's their writing. Keep their voice: their plain words, their rhythm, their register. Never make it sound corporate, polished for polish's sake, or like an AI wrote it. Prefer cutting explanation to adding it.

You'll get the passage around the spot, with the spot marked ⟦like this⟧. Each alternative replaces exactly the marked text and nothing outside it, so it has to slot in: the grammar, tense, number and capitalization the sentence around it needs. (An "a" or "an" right before the spot gets fixed automatically.) Keep any markdown inside the spot (links, emphasis) when it matters.

Make them different from each other and from the ones already there. Mix close swaps with a couple of surprising ones.

Reply with JSON only:
{"options":[{"text":"…","why":"two to five words on the angle"}]}`;

const UNIT_GUIDE: Record<Unit, string> = {
  word: 'The spot is a word or a short phrase. Give single words or short phrases.',
  phrase: 'The spot is a phrase. Rephrase just that phrase.',
  sentence: 'The spot is a sentence. Give rewrites of the whole sentence, each a real take: plainer, punchier, more concrete, flipped around, shorter, warmer, stranger. Keep the meaning unless the writer steers otherwise.',
  paragraph: "The spot is a paragraph (or more). Give rewrites of the whole thing, each a real take: tighter, reordered, more alive, more concrete. Keep the meaning and the best lines unless steered otherwise. Never longer than the original.",
};

export async function alternatives(plugin: WordplayPlugin, ctx: AltContext, count: number): Promise<AltIdea[]> {
  const brain: Brain = ctx.unit === 'word' || (ctx.unit === 'phrase' && ctx.target.split(/\s+/).length <= 3) ? plugin.settings.brains.words : plugin.settings.brains.rewrites;
  const voice = plugin.settings.voice.trim();
  const user = [
    `Note: ${ctx.title}`,
    `How many: ${count}`,
    UNIT_GUIDE[ctx.unit],
    voice ? `About the writer: ${voice}` : '',
    ctx.steer ? `The writer's steer for these: ${ctx.steer}` : '',
    ctx.existing.length ? `Already there (don't repeat these):\n${ctx.existing.map((e) => `- ${e}`).join('\n')}` : '',
    `The passage:\n${ctx.before}⟦${ctx.target}⟧${ctx.after}`,
  ].filter(Boolean).join('\n\n');
  const raw = await chat(plugin, brain, [{ role: 'system', content: ALT_SYSTEM }, { role: 'user', content: user }], {
    temperature: 0.9, maxTokens: ctx.unit === 'paragraph' ? 3000 : ctx.unit === 'sentence' ? 1500 : 600,
  });
  const parsed = parseJson<{ options?: Array<{ text?: unknown; why?: unknown }> } | Array<{ text?: unknown; why?: unknown }>>(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.options ?? [];
  return list
    .map((o) => ({ text: typeof o?.text === 'string' ? o.text.replace(/^⟦|⟧$/g, '') : '', why: typeof o?.why === 'string' ? o.why : undefined }))
    .filter((o) => o.text.trim() && o.text.trim() !== ctx.target.trim())
    .slice(0, count + 2);
}
