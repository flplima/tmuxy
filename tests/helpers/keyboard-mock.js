/**
 * A phone keyboard for the E2E suite and the changelog screencasts, which no
 * headless browser draws. A real one covers the bottom of the page and only
 * the visual viewport shrinks (the layout viewport keeps its height), which
 * is what the app follows (components/phone/usePhoneViewport.ts). So the mock
 * does exactly that: `window.visualViewport.height` reports `height` px less
 * and fires its `resize`, and the keyboard the stories draw
 * (packages/tmuxy-ui/src/stories/keyboardMock.ts) is fixed in the space below.
 */

const { storyModule, inPage } = require('./story-module');

const { drawKeyboard } = storyModule('keyboardMock.ts');

/** Runs in the page: bring the keyboard up (`height` > 0) or put it away (0). */
function setKeyboard(height, draw) {
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
  const board = draw(document.body, height);
  Object.assign(board.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: '0',
    zIndex: '99998',
  });
}

/** Bring the mock keyboard up on `page`, `height` px tall. */
const showKeyboard = (page, height) => page.evaluate(inPage(setKeyboard, [height], [drawKeyboard]));

/** Put the mock keyboard away. */
const hideKeyboard = (page) => page.evaluate(inPage(setKeyboard, [0], [drawKeyboard]));

module.exports = { showKeyboard, hideKeyboard };
