/**
 * The feel of it: two little tones while you cycle (a lower one means you're home, on the original),
 * a poof when an option you hate explodes, a whoosh when something's stashed,
 * and an underline that wobbles like an editor's pen instead of a ruler.
 */
import type { EditorView } from '@codemirror/view';

export const fx = { sounds: true, explosions: true, volume: 0.5 };

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (!fx.sounds) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function blip(freq: number, glide: number, length: number, level: number, type: OscillatorType = 'sine', delay = 0): void {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * glide, t + length * 0.8);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * fx.volume), t + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

function noise(length: number, level: number, from: number, to: number, filter: BiquadFilterType): void {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const frames = Math.floor(a.sampleRate * length);
  const buffer = a.createBuffer(1, frames, a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = a.createBufferSource();
  src.buffer = buffer;
  const f = a.createBiquadFilter();
  f.type = filter;
  f.Q.value = 0.9;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + length);
  const gain = a.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * fx.volume), t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  src.connect(f).connect(gain).connect(a.destination);
  src.start(t);
  src.stop(t + length + 0.02);
}

export const sound = {
  /** moving to another alternative */
  next: () => blip(880, 1.04, 0.11, 0.09),
  /** back to the original: lower, so you know you're home */
  home: () => blip(440, 0.96, 0.16, 0.11),
  /** an option explodes */
  poof: () => { noise(0.32, 0.5, 2400, 260, 'bandpass'); blip(150, 0.5, 0.18, 0.12, 'triangle'); },
  /** something's stashed */
  whoosh: () => noise(0.38, 0.22, 500, 4200, 'bandpass'),
  /** settled, or a pass came back */
  settle: () => { blip(659, 1, 0.12, 0.06); blip(988, 1, 0.18, 0.05, 'sine', 0.07); },
  /** can't do that */
  nope: () => blip(196, 0.9, 0.12, 0.08, 'triangle'),
};

// ---- letters flying ----

interface Glyph { ch: string; left: number; top: number; height: number; font: string; color: string }

function glyphs(view: EditorView, from: number, to: number, max = 160): Glyph[] {
  const out: Glyph[] = [];
  const step = Math.max(1, Math.ceil((to - from) / max));
  const styles = new Map<Element, CSSStyleDeclaration>();
  for (let pos = from; pos < to; pos += step) {
    const ch = view.state.doc.sliceString(pos, pos + 1);
    if (!ch.trim()) continue;
    const c = view.coordsAtPos(pos, 1);
    if (!c || c.bottom < 0 || c.top > window.innerHeight) continue;
    let el: Element | null = null;
    try {
      const at = view.domAtPos(pos + 1);
      el = at.node.nodeType === 1 ? (at.node as Element) : at.node.parentElement;
    } catch { el = view.contentDOM; }
    el ??= view.contentDOM;
    let style = styles.get(el);
    if (!style) { style = getComputedStyle(el); styles.set(el, style); }
    out.push({ ch, left: c.left, top: c.top, height: c.bottom - c.top, font: style.font, color: style.color });
  }
  return out;
}

function layer(): HTMLElement {
  const el = document.body.createDiv({ cls: 'wp-fx-layer' });
  window.setTimeout(() => el.remove(), 1800);
  return el;
}

function place(parent: HTMLElement, g: Glyph): HTMLElement {
  const span = parent.createSpan({ cls: 'wp-fx-char', text: g.ch });
  span.style.left = `${g.left}px`;
  span.style.top = `${g.top}px`;
  span.style.lineHeight = `${g.height}px`;
  span.style.font = g.font;
  span.style.color = g.color;
  return span;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** the text at from–to bursts into its letters. Call before the text is gone. */
export function explode(view: EditorView, from: number, to: number): void {
  if (!fx.explosions || to <= from) return;
  const gs = glyphs(view, from, to);
  if (!gs.length) return;
  const root = layer();
  const cx = gs.reduce((s, g) => s + g.left, 0) / gs.length;
  const cy = gs.reduce((s, g) => s + g.top + g.height / 2, 0) / gs.length;

  const flash = root.createDiv({ cls: 'wp-fx-flash' });
  flash.style.left = `${cx}px`;
  flash.style.top = `${cy}px`;
  flash.animate([{ transform: 'translate(-50%,-50%) scale(0.2)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(3.2)', opacity: 0 }], { duration: 420, easing: 'ease-out', fill: 'forwards' });

  for (const g of gs) {
    const span = place(root, g);
    const angle = Math.atan2(g.top + g.height / 2 - cy + rand(-6, 6), g.left - cx + rand(-6, 6)) + rand(-0.6, 0.6);
    const speed = rand(80, 230);
    const dx = Math.cos(angle) * speed;
    const dy = Math.sin(angle) * speed - rand(30, 90);
    const spin = rand(-300, 300);
    span.animate([
      { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1 },
      { offset: 0.3, transform: `translate(${dx * 0.6}px, ${dy * 0.6}px) rotate(${spin * 0.4}deg) scale(1.45)`, opacity: 1 },
      { offset: 0.7, opacity: 0.85 },
      { transform: `translate(${dx}px, ${dy + rand(90, 160)}px) rotate(${spin}deg) scale(0.6)`, opacity: 0 },
    ], { duration: rand(900, 1300), easing: 'cubic-bezier(.16,.62,.36,1)', fill: 'forwards' });
  }
  for (let i = 0; i < 20; i++) {
    const spark = root.createDiv({ cls: 'wp-fx-spark' });
    spark.style.left = `${cx}px`;
    spark.style.top = `${cy}px`;
    const angle = rand(0, Math.PI * 2);
    const d = rand(50, 160);
    if (i % 3 === 0) spark.addClass('is-ai');
    spark.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: `translate(${Math.cos(angle) * d}px, ${Math.sin(angle) * d}px) scale(0.2)`, opacity: 0 },
    ], { duration: rand(380, 620), easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'forwards' });
  }
}

/** the text at from–to sails off to the right, toward the scratchpad. Call before the text is gone. */
export function flyAway(view: EditorView, from: number, to: number): void {
  if (!fx.explosions || to <= from) return;
  const gs = glyphs(view, from, to);
  if (!gs.length) return;
  const root = layer();
  const edge = window.innerWidth + 40;
  gs.forEach((g, i) => {
    const span = place(root, g);
    const dx = edge - g.left + rand(0, 80);
    const lift = rand(-40, 10);
    span.animate([
      { transform: 'translate(0,0)', opacity: 1 },
      { offset: 0.25, transform: `translate(${rand(-6, 6)}px, ${lift * 0.4}px)`, opacity: 1 },
      { transform: `translate(${dx}px, ${lift}px) scale(0.7)`, opacity: 0 },
    ], { duration: rand(520, 760), delay: Math.min(i * 4, 400), easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
  });
}

/** a no: a little shake */
export function shake(el: HTMLElement | null | undefined): void {
  el?.animate([
    { transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(4px)' },
    { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' },
  ], { duration: 260, easing: 'ease-out' });
}

// ---- the pen ----

/** a seamless tile of a slightly wobbly line, like an editor's pen */
function penPath(seed: number): string {
  let s = seed;
  const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const w = 140;
  const pts: Array<[number, number]> = [];
  for (let x = 0; x <= w; x += 14) pts.push([x, 3 + (x === 0 || x === w ? 0 : (r() - 0.5) * 2.2)]);
  let d = `M${pts[0][0]} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 2] ?? pts[i - 1];
    const p1 = pts[i - 1];
    const p2 = pts[i];
    const p3 = pts[i + 1] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0]} ${p2[1].toFixed(2)}`;
  }
  return d;
}

function penUrl(color: string, seed: number, width: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="6" viewBox="0 0 140 6"><path d="${penPath(seed)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** draws the pens in the theme's current colors (call again when the theme changes) */
export function inkPens(): void {
  const body = document.body;
  const style = getComputedStyle(body);
  // the fallbacks are for the moment before the stylesheet arrives (it's inked again once it has)
  const pens: Array<[string, string, string, number, number]> = [
    ['original', '--wp-color-original', '#8a8a8a', 11, 1.2],
    ['human', '--wp-color-human', '#e0915a', 23, 1.5],
    ['ai', '--wp-color-ai', '#9d86e9', 37, 1.5],
    ['typo', '--wp-color-typo', '#e5636b', 53, 1.4],
    ['mark', '--wp-color-mark', '#d9c35c', 71, 1.4],
  ];
  for (const [name, variable, fallback, seed, width] of pens) {
    const color = style.getPropertyValue(variable).trim() || fallback;
    body.style.setProperty(`--wp-pen-${name}`, penUrl(color, seed, width));
  }
}

export function clearPens(): void {
  for (const name of ['original', 'human', 'ai', 'typo', 'mark']) document.body.style.removeProperty(`--wp-pen-${name}`);
}
