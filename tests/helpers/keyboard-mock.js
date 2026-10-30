/**
 * A phone keyboard for the E2E suite and the changelog screencasts, which no
 * headless browser draws. A real one covers the bottom of the page and only
 * the visual viewport shrinks (the layout viewport keeps its height), which
 * is what the app follows (hooks/usePhoneViewport.ts). So the mock does
 * exactly that: `window.visualViewport.height` reports `height` px less and
 * fires its `resize`, and a keyboard is drawn, fixed, in the space below.
 *
 * packages/tmuxy-ui/src/stories/keyboardMock.ts does the same for stories,
 * where it shrinks the story's frame instead; the drawing is the same.
 */

/** Runs in the page: bring the keyboard up (`height` > 0) or put it away (0). */
function setKeyboard(height) {
  const viewport = window.visualViewport;
  document.querySelector('[data-testid="mock-keyboard"]')?.remove();
  if (height > 0) {
    Object.defineProperty(viewport, 'height', {
      configurable: true,
      get: () => window.innerHeight - height,
    });
  } else {
    delete viewport.height;
  }
  viewport.dispatchEvent(new Event('resize'));
  if (height <= 0) return;

  const board = document.createElement('div');
  board.dataset.testid = 'mock-keyboard';
  board.setAttribute('aria-hidden', 'true');
  Object.assign(board.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: '0',
    height: `${height}px`,
    zIndex: '99998',
    boxSizing: 'border-box',
    padding: '6px 3px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    background: '#2b2b2e',
    pointerEvents: 'none',
    font: '500 15px system-ui, sans-serif',
    color: '#f2f2f7',
  });
  for (const keys of ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', ' ']) {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '5px', flex: '1', justifyContent: 'center' });
    for (const key of keys === ' ' ? ['123', 'space', 'return'] : [...keys]) {
      const cap = document.createElement('span');
      cap.textContent = key;
      Object.assign(cap.style, {
        flex: key === 'space' ? '5' : '1',
        maxWidth: key.length > 1 ? 'none' : '34px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '5px',
        background: key.length > 1 ? '#46464b' : '#636366',
      });
      row.appendChild(cap);
    }
    board.appendChild(row);
  }
  document.body.appendChild(board);
}

/** Bring the mock keyboard up on `page`, `height` px tall. */
const showKeyboard = (page, height) => page.evaluate(setKeyboard, height);

/** Put the mock keyboard away. */
const hideKeyboard = (page) => page.evaluate(setKeyboard, 0);

module.exports = { showKeyboard, hideKeyboard, setKeyboard };
