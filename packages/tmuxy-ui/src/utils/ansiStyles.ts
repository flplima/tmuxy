/**
 * ANSI Style Utilities
 *
 * Shared utilities for building CSS styles from ANSI parsed content.
 * Uses CSS variables for standard 16 terminal colors, RGB for true color.
 * Implements style object pooling to reduce GC pressure.
 */

import type { AnserJsonEntry } from 'anser';

/**
 * xterm standard 16 color RGB values mapped to CSS variable names
 * These match the --term-* variables defined in styles.css
 */
/**
 * Map normalized "r,g,b" strings to CSS variable names.
 * Anser outputs RGB values with inconsistent spacing (e.g., "0, 0, 0" or "255,255,255").
 * We normalize by stripping spaces before lookup (see rgbToColor).
 */
const STANDARD_COLORS: Record<string, string> = {
  // Anser's standard 8 colors (ANSI 30-37 / 40-47)
  '0,0,0': 'var(--term-black)',
  '187,0,0': 'var(--term-red)',
  '0,187,0': 'var(--term-green)',
  '187,187,0': 'var(--term-yellow)',
  '0,0,187': 'var(--term-blue)',
  '187,0,187': 'var(--term-magenta)',
  '0,187,187': 'var(--term-cyan)',
  '255,255,255': 'var(--term-white)',
  // Anser's bright 8 colors (ANSI 90-97 / 100-107)
  '85,85,85': 'var(--term-bright-black)',
  '255,85,85': 'var(--term-bright-red)',
  '0,255,0': 'var(--term-bright-green)',
  '255,255,85': 'var(--term-bright-yellow)',
  '85,85,255': 'var(--term-bright-blue)',
  '255,85,255': 'var(--term-bright-magenta)',
  '85,255,255': 'var(--term-bright-cyan)',
  // 255,255,255 already mapped to --term-white above; bright white is the same in Anser
};

/**
 * Style Object Pool - Reuses style objects for common ANSI combinations
 * Reduces GC pressure by avoiding new object allocation for each span
 */
const STYLE_CACHE_MAX_SIZE = 256;
const styleCache = new Map<string, React.CSSProperties>();

/**
 * Generate cache key from ANSI style properties
 */
function getStyleCacheKey(part: AnserJsonEntry): string {
  // Normalize spaces in color strings for consistent caching
  const fg = part.fg?.replace(/\s/g, '') || '';
  const bg = part.bg?.replace(/\s/g, '') || '';
  return `${fg},${bg},${part.decorations.sort().join(':')}`;
}

/**
 * Convert RGB string to CSS color value
 * Uses CSS variable for standard colors, rgb() for true color
 */
function rgbToColor(rgb: string): string {
  // Normalize spaces: Anser may output "0, 187, 0" or "255,255,255"
  const normalized = rgb.replace(/\s/g, '');
  const cssVar = STANDARD_COLORS[normalized];
  if (cssVar) {
    return cssVar;
  }
  // True color - use rgb() directly
  return `rgb(${rgb})`;
}

/**
 * Build React CSS properties from Anser parsed entry (internal, uncached)
 */
function buildAnsiStyleUncached(part: AnserJsonEntry): React.CSSProperties {
  const style: React.CSSProperties = {};
  const isReverse = part.decorations.includes('reverse');

  if (isReverse) {
    // Swap foreground and background colors for reverse video
    style.color = part.bg ? rgbToColor(part.bg) : 'var(--term-background)';
    style.backgroundColor = part.fg ? rgbToColor(part.fg) : 'var(--term-foreground)';
  } else {
    if (part.fg) style.color = rgbToColor(part.fg);
    if (part.bg) style.backgroundColor = rgbToColor(part.bg);
  }

  if (part.decorations.includes('bold')) style.fontWeight = 'bold';
  if (part.decorations.includes('dim')) style.opacity = 0.5;
  if (part.decorations.includes('italic')) style.fontStyle = 'italic';
  if (part.decorations.includes('hidden')) style.visibility = 'hidden';
  if (part.decorations.includes('blink')) {
    style.animation = 'terminal-blink 1s step-end infinite';
  }

  // Handle text decorations (can be combined)
  const decorations: string[] = [];
  if (part.decorations.includes('underline')) decorations.push('underline');
  if (part.decorations.includes('strikethrough')) decorations.push('line-through');
  if (decorations.length > 0) style.textDecoration = decorations.join(' ');

  return style;
}

/**
 * Build React CSS properties from Anser parsed entry (with caching)
 */
export function buildAnsiStyle(part: AnserJsonEntry): React.CSSProperties {
  const cacheKey = getStyleCacheKey(part);

  const cached = styleCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const style = buildAnsiStyleUncached(part);

  // LRU eviction: remove oldest entry if cache is full
  if (styleCache.size >= STYLE_CACHE_MAX_SIZE) {
    const firstKey = styleCache.keys().next().value;
    if (firstKey !== undefined) {
      styleCache.delete(firstKey);
    }
  }

  styleCache.set(cacheKey, style);
  return style;
}
