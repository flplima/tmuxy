/**
 * A duration a CSS custom property holds (`180ms cubic-bezier(…)`,
 * `0.15s ease`), in milliseconds, as `el` computes it: the stylesheet is the
 * one place a transition's length is written, and a theme or
 * `prefers-reduced-motion` that changes the token changes the timers waiting
 * on the transition with it. 0 when the property is unset.
 */
export function cssDurationMs(el: Element, property: string): number {
  const m = getComputedStyle(el)
    .getPropertyValue(property)
    .match(/(\d*\.?\d+)(ms|s)\b/);
  return m ? Number(m[1]) * (m[2] === 's' ? 1000 : 1) : 0;
}
