/**
 * A small floating menu in Wordplay's own glass (Obsidian's menus are native on this Mac, so they can't be styled).
 * Arrow keys move, enter picks, escape closes; the keys for each thing sit on the right.
 */
import { setIcon } from 'obsidian';

export interface MenuItem {
  label: string;
  hint?: string;
  icon?: string;
  disabled?: boolean;
  run: () => void;
}

export interface MenuSection { title?: string; note?: string; items: MenuItem[] }

let open: Popover | null = null;

export class Popover {
  readonly el: HTMLElement;
  private buttons: HTMLElement[] = [];
  private index = -1;
  private cleanup: Array<() => void> = [];

  constructor(sections: MenuSection[], private onClose?: () => void) {
    open?.close();
    open = this;
    this.el = document.body.createDiv({ cls: 'wp-pop' });
    this.el.tabIndex = -1;
    for (const section of sections) {
      if (!section.items.length && !section.note) continue;
      const sec = this.el.createDiv({ cls: 'wp-pop-section' });
      if (section.title) sec.createDiv({ cls: 'wp-pop-title', text: section.title });
      if (section.note) sec.createDiv({ cls: 'wp-pop-note', text: section.note });
      for (const item of section.items) {
        const b = sec.createDiv({ cls: 'wp-pop-item' + (item.disabled ? ' is-disabled' : '') });
        if (item.icon) setIcon(b.createSpan({ cls: 'wp-pop-icon' }), item.icon);
        b.createSpan({ cls: 'wp-pop-label', text: item.label });
        if (item.hint) b.createSpan({ cls: 'wp-pop-hint', text: item.hint });
        if (item.disabled) continue;
        const i = this.buttons.length;
        this.buttons.push(b);
        b.addEventListener('mousemove', () => this.highlight(i));
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => this.pick(item));
        (b as HTMLElement & { wpRun?: () => void }).wpRun = () => this.pick(item);
      }
    }
    this.el.addEventListener('keydown', (e) => this.key(e));
    const outside = (e: MouseEvent) => { if (!this.el.contains(e.target as Node)) this.close(); };
    const blur = () => this.close();
    const wheel = (e: WheelEvent) => { if (!this.el.contains(e.target as Node)) this.close(); };
    // listen from the next tick, so the click that opened the menu can't close it
    window.setTimeout(() => {
      if (!this.el.isConnected) return;
      document.addEventListener('mousedown', outside, true);
      window.addEventListener('blur', blur);
      document.addEventListener('wheel', wheel, true);
    }, 0);
    this.cleanup.push(() => document.removeEventListener('mousedown', outside, true), () => window.removeEventListener('blur', blur), () => document.removeEventListener('wheel', wheel, true));
  }

  /** at a point (a right-click), flipping up or left if it would fall off the window */
  showAt(x: number, y: number): this {
    const r = this.el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    const top = y + r.height + 8 > window.innerHeight ? Math.max(8, y - r.height) : y;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.addClass('is-open');
    this.el.focus({ preventScroll: true });
    return this;
  }

  highlight(i: number): void {
    this.buttons[this.index]?.removeClass('is-active');
    this.index = i;
    this.buttons[i]?.addClass('is-active');
  }

  private key(e: KeyboardEvent): void {
    const n = this.buttons.length;
    if (e.key === 'ArrowDown') { this.highlight(n ? (this.index + 1) % n : -1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { this.highlight(n ? (this.index - 1 + n) % n : -1); e.preventDefault(); }
    else if (e.key === 'Enter') {
      const b = this.buttons[this.index] as (HTMLElement & { wpRun?: () => void }) | undefined;
      b?.wpRun?.();
      e.preventDefault();
    } else if (e.key === 'Escape') { this.close(); e.preventDefault(); }
    e.stopPropagation();
  }

  private pick(item: MenuItem): void {
    this.close();
    item.run();
  }

  close(restore = true): void {
    if (open === this) open = null;
    for (const c of this.cleanup.splice(0)) c();
    if (!this.el.isConnected) return;
    this.el.remove();
    if (restore) this.onClose?.();
  }
}
