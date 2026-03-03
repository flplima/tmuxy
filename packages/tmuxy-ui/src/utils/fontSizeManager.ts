const LS_KEY = 'tmuxy-font-size';
export const DEFAULT_FONT_SIZE = 15;
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 21;

export function applyFontSize(size: number): void {
  document.documentElement.style.setProperty('--tmuxy-font-size', `${size}px`);
}

export function loadFontSizeFromStorage(): number {
  try {
    const val = localStorage.getItem(LS_KEY);
    if (val) {
      const n = parseInt(val, 10);
      if (n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) return n;
    }
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_FONT_SIZE;
}

export function saveFontSizeToStorage(size: number): void {
  try {
    localStorage.setItem(LS_KEY, String(size));
  } catch {
    // localStorage unavailable
  }
}

export function increaseFontSize(current: number): number {
  return Math.min(current + 1, MAX_FONT_SIZE);
}

export function decreaseFontSize(current: number): number {
  return Math.max(current - 1, MIN_FONT_SIZE);
}

export function loadCursorBlinkFromStorage(): boolean {
  try {
    const val = localStorage.getItem('tmuxy-cursor-blink');
    if (val !== null) return val === 'true';
  } catch {
    // localStorage unavailable
  }
  return true;
}

export function saveCursorBlinkToStorage(blink: boolean): void {
  try {
    localStorage.setItem('tmuxy-cursor-blink', String(blink));
  } catch {
    // localStorage unavailable
  }
}
