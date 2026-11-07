/**
 * Where the smooth cursor is drawn. The overlay element spans the window, so
 * the cursor is the polygon its `.smooth-cursor-shape` clips to (SmoothCursor).
 * Shared by the stories and the E2E suite (tests/helpers/layout-helpers.js
 * rebuilds it in the page from its source): self-contained, erasable
 * TypeScript only.
 */

/** The corners of a `clip-path: polygon(…)` in px, in order; none for anything else. */
export function cursorPolygon(clipPath: string): Array<[number, number]> {
  return [...clipPath.matchAll(/(-?[\d.]+)px\s+(-?[\d.]+)px/g)].map((m): [number, number] => [
    Number(m[1]),
    Number(m[2]),
  ]);
}
