/**
 * What the phone stories share: the app snapshot a story reads, a box on
 * screen, and one finger's touch sequences as the browser would dispatch
 * them (PhoneLayout.stories.tsx, PhoneBottomView.stories.tsx).
 */

interface Snap {
  context: {
    targetCols: number;
    targetRows: number;
    charWidth: number;
    charHeight: number;
    phoneLayout: boolean;
    phoneLandscape: boolean;
  };
}
export const ctx = () =>
  (window as unknown as { app: { getSnapshot(): Snap } }).app.getSnapshot().context;

export const box = (el: Element | null) => {
  if (!el) throw new Error('missing element');
  return el.getBoundingClientRect();
};

/** One finger on `el`: a touch sequence, as the browser would dispatch it. */
export function touch(
  el: Element,
  type: 'touchstart' | 'touchmove' | 'touchend',
  x: number,
  y: number,
) {
  const point = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
  const touches = type === 'touchend' ? [] : [point];
  el.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches,
      changedTouches: [point],
      targetTouches: touches,
    }),
  );
}

export function tapAt(el: Element, x: number, y: number) {
  touch(el, 'touchstart', x, y);
  touch(el, 'touchend', x, y);
}

export function swipeAcross(el: Element, y: number, fromX: number, toX: number) {
  touch(el, 'touchstart', fromX, y);
  for (let i = 1; i <= 6; i++) touch(el, 'touchmove', fromX + ((toX - fromX) * i) / 6, y);
  touch(el, 'touchend', toX, y);
}
