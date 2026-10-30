/**
 * A phone keyboard for stories, which no headless browser draws: the story's
 * screen (the frame FixtureProvider sizes) loses `height` px at the bottom,
 * as the visual viewport does when a real keyboard comes up, and a keyboard
 * is drawn in the space it leaves so a reader of the story sees why.
 *
 * tests/helpers/keyboard-mock.js does the same for the E2E suite and the
 * changelog screencasts against the real app, where it shrinks the visual
 * viewport itself; the drawing is the same.
 */

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** Draw a keyboard `height` px tall into `host`, filling its width. */
function drawKeyboard(host: HTMLElement, height: number): HTMLElement {
  const board = document.createElement('div');
  board.dataset.testid = 'mock-keyboard';
  board.setAttribute('aria-hidden', 'true');
  Object.assign(board.style, {
    height: `${height}px`,
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
  for (const keys of [...ROWS, ' ']) {
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
  host.appendChild(board);
  return board;
}

/**
 * Bring a keyboard up under the app in a story: the frame `appContainer`
 * sits in loses `height` px and the keyboard fills them. Returns what puts
 * it away again.
 */
export function mockKeyboard(appContainer: Element, height: number): () => void {
  const frame = appContainer.parentElement as HTMLElement;
  const before = frame.style.height;
  const total = frame.getBoundingClientRect().height;
  frame.style.height = `${total - height}px`;
  const board = document.createElement('div');
  Object.assign(board.style, { width: `${frame.getBoundingClientRect().width}px` });
  frame.after(board);
  drawKeyboard(board, height);
  return () => {
    frame.style.height = before;
    board.remove();
  };
}
