export const DEFAULT_FONT_SIZE = 15;
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 21;

/** The chrome's small text (sidebar, status line) is 80% of the pane font, rounded to whole pixels. */
export function smallFontSize(size: number): number {
  return Math.round(size * 0.8);
}

export function applyFontSize(size: number): void {
  const root = document.documentElement.style;
  root.setProperty('--tmuxy-font-size', `${size}px`);
  root.setProperty('--tmuxy-small-font-size', `${smallFontSize(size)}px`);
}

/** A size the font menu can reach. */
export function isFontSize(size: number): boolean {
  return Number.isInteger(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE;
}

export function increaseFontSize(current: number): number {
  return Math.min(current + 1, MAX_FONT_SIZE);
}

export function decreaseFontSize(current: number): number {
  return Math.max(current - 1, MIN_FONT_SIZE);
}
