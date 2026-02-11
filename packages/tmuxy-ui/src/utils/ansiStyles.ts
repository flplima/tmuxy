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
const STANDARD_COLORS: Record<string, string> = {
  // Normal colors (0-7)
  '0,0,0': 'var(--term-black)',
  '205,0,0': 'var(--term-red)',
  '0,205,0': 'var(--term-green)',
  '205,205,0': 'var(--term-yellow)',
  '0,0,238': 'var(--term-blue)',
  '205,0,205': 'var(--term-magenta)',
  '0,205,205': 'var(--term-cyan)',
  '229,229,229': 'var(--term-white)',
  // Bright colors (8-15)
  '127,127,127': 'var(--term-bright-black)',
  '255,0,0': 'var(--term-bright-red)',
  '0,255,0': 'var(--term-bright-green)',
  '255,255,0': 'var(--term-bright-yellow)',
  '92,92,255': 'var(--term-bright-blue)',
  '255,0,255': 'var(--term-bright-magenta)',
  '0,255,255': 'var(--term-bright-cyan)',
  '255,255,255': 'var(--term-bright-white)',
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
  return `${part.fg || ''},${part.bg || ''},${part.decorations.sort().join(':')}`;
}

/**
 * Convert RGB string to CSS color value
 * Uses CSS variable for standard colors, rgb() for true color
 */
function rgbToColor(rgb: string): string {
  // Check if it's a standard terminal color
  const cssVar = STANDARD_COLORS[rgb];
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
