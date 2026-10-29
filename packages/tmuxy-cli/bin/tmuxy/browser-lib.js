'use strict';
/**
 * The pure parts of `tmuxy widget browser` (browser.js): how a pane's cells
 * become a page's pixels and back, how a screencast frame becomes Kitty
 * graphics tmux relays, and how the bytes a pane delivers — typed keys, SGR
 * mouse reports — become DevTools input events. No DOM, no sockets, no
 * timers, so tests/cli/cli-browser.test.js can read every mapping.
 */

const ESC = '\x1b';

/** A terminal cell in page pixels: the same ratio the UI draws at. */
const DEFAULT_CELL = { width: 8, height: 16 };

/** The key that ends the session; everything else goes to the page. */
const QUIT_BYTE = 0x11; // Ctrl+Q

/**
 * The page's viewport for a pane of `cols` × `rows` cells: every row but the
 * last, which carries the status line, each cell `cell` pixels. The
 * screencast is asked for exactly this size, so a frame fills its cells
 * edge to edge and a cell maps straight to a pixel block.
 */
function viewportFor(cols, rows, cell = DEFAULT_CELL) {
  const frameRows = Math.max(1, rows - 1);
  return {
    width: Math.max(1, cols) * cell.width,
    height: frameRows * cell.height,
    cols: Math.max(1, cols),
    rows: frameRows,
  };
}

/** The pixel at the middle of cell (`col`, `row`), both 1-based as SGR reports them. */
function cellToPixel(col, row, cell = DEFAULT_CELL) {
  return {
    x: (Math.max(1, col) - 1) * cell.width + cell.width / 2,
    y: (Math.max(1, row) - 1) * cell.height + cell.height / 2,
  };
}

/**
 * A sequence wrapped for tmux to relay verbatim (DCS tmux passthrough, every
 * ESC doubled). tmux reads a bare APC as a pane title; wrapped, it reaches
 * tmuxy's parser as the application wrote it.
 */
function passthrough(seq) {
  return `${ESC}Ptmux;${seq.replace(/\x1b/g, `${ESC}${ESC}`)}${ESC}\\`;
}

/**
 * One screencast frame as Kitty graphics: the image's own bytes (`f=100`,
 * PNG or JPEG as the browser encoded them) in 4096-byte base64 chunks, shown
 * over `cols` × `rows` cells at the cursor. Preceded by a cursor home so each
 * frame lands on the same anchor and replaces the last one in place.
 */
function kittyFrame(base64, cols, rows, chunkSize = 4096) {
  const chunks = [];
  for (let i = 0; i < base64.length; i += chunkSize) chunks.push(base64.slice(i, i + chunkSize));
  if (chunks.length === 0) chunks.push('');
  const out = [`${ESC}[H`];
  chunks.forEach((chunk, i) => {
    const last = i === chunks.length - 1;
    const keys =
      i === 0 ? `a=T,f=100,q=2,c=${cols},r=${rows},m=${last ? 0 : 1}` : `m=${last ? 0 : 1}`;
    out.push(passthrough(`${ESC}_G${keys};${chunk}${ESC}\\`));
  });
  return out.join('');
}

/** The status line on the pane's last row: the page's title and address, and the way out. */
function statusLine(rows, cols, title, url) {
  const text = `${title ? `${title} — ` : ''}${url}`;
  const hint = ' Ctrl+Q quits ';
  const room = Math.max(0, cols - hint.length);
  const shown = text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text.padEnd(room);
  return `${ESC}[${rows};1H${ESC}[7m${shown.slice(0, room)}${hint}${ESC}[0m`;
}

/** What the terminal is told while the session runs, and the exact undo. */
const ENTER = `${ESC}[?1049h${ESC}[?25l${ESC}[?1003h${ESC}[?1006h${ESC}[2J`;
const LEAVE = `${ESC}[?1006l${ESC}[?1003l${ESC}[?25h${ESC}[?1049l`;

// --- Input: the bytes the pane delivers → events ------------------------------

const KEY_SEQUENCES = {
  '[A': 'ArrowUp',
  '[B': 'ArrowDown',
  '[C': 'ArrowRight',
  '[D': 'ArrowLeft',
  '[H': 'Home',
  '[F': 'End',
  '[1~': 'Home',
  '[4~': 'End',
  '[2~': 'Insert',
  '[3~': 'Delete',
  '[5~': 'PageUp',
  '[6~': 'PageDown',
  OA: 'ArrowUp',
  OB: 'ArrowDown',
  OC: 'ArrowRight',
  OD: 'ArrowLeft',
  OH: 'Home',
  OF: 'End',
};

const SGR_MOUSE = /^\[<(\d+);(\d+);(\d+)([Mm])/;

/**
 * Parse the bytes a pane delivered into events, returning what could not be
 * read yet (a sequence cut at the chunk's end) as `rest`. Events:
 *   { kind: 'quit' }
 *   { kind: 'text', text }                       printable characters
 *   { kind: 'key', key, ctrl, alt }               Enter, Tab, Escape, arrows, a Ctrl chord…
 *   { kind: 'mouse', action, button, col, row, delta }   press / release / move / wheel
 */
function parseInput(input) {
  const s = typeof input === 'string' ? input : input.toString('utf8');
  const events = [];
  let i = 0;
  let text = '';
  const flushText = () => {
    if (text) events.push({ kind: 'text', text });
    text = '';
  };
  while (i < s.length) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (ch === ESC) {
      const tail = s.slice(i + 1);
      if (tail === '') {
        // ESC at the chunk's end: a sequence may follow in the next read.
        flushText();
        return { events, rest: ESC };
      }
      const mouse = tail.match(SGR_MOUSE);
      if (mouse) {
        flushText();
        events.push(
          mouseEvent(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), mouse[4] === 'M'),
        );
        i += 1 + mouse[0].length;
        continue;
      }
      if (
        tail.startsWith('[<') ||
        (tail.startsWith('[') && /^\[[\d;]*$/.test(tail)) ||
        tail === 'O'
      ) {
        // A CSI or SS3 still arriving.
        flushText();
        return { events, rest: s.slice(i) };
      }
      const named = Object.keys(KEY_SEQUENCES).find((k) => tail.startsWith(k));
      if (named) {
        flushText();
        events.push({ kind: 'key', key: KEY_SEQUENCES[named], ctrl: false, alt: false });
        i += 1 + named.length;
        continue;
      }
      if (tail[0] === '[' || tail[0] === 'O') {
        // An unknown CSI/SS3: skip it whole rather than type its letters.
        const m = tail.match(/^[[O][\d;?]*[@-~]/);
        if (m) {
          i += 1 + m[0].length;
          continue;
        }
      }
      // Alt+<char>: ESC then the character.
      const next = tail[0];
      flushText();
      if (next === ESC) {
        events.push({ kind: 'key', key: 'Escape', ctrl: false, alt: false });
        i += 1;
        continue;
      }
      events.push({ kind: 'key', key: next, ctrl: false, alt: true });
      i += 2;
      continue;
    }
    if (code === QUIT_BYTE) {
      flushText();
      events.push({ kind: 'quit' });
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      flushText();
      events.push({ kind: 'key', key: 'Enter', ctrl: false, alt: false });
    } else if (ch === '\t') {
      flushText();
      events.push({ kind: 'key', key: 'Tab', ctrl: false, alt: false });
    } else if (code === 0x7f || code === 0x08) {
      flushText();
      events.push({ kind: 'key', key: 'Backspace', ctrl: false, alt: false });
    } else if (code < 0x20) {
      // A control character: Ctrl plus the letter it stands for.
      flushText();
      events.push({ kind: 'key', key: String.fromCharCode(code + 0x60), ctrl: true, alt: false });
    } else {
      text += ch;
    }
    i += 1;
  }
  flushText();
  return { events, rest: '' };
}

/** One SGR mouse report as an event. `pressed` is the trailing M (press/move) vs m (release). */
function mouseEvent(b, col, row, pressed) {
  if (b >= 64) {
    return { kind: 'mouse', action: 'wheel', button: 'none', col, row, delta: b & 1 ? 1 : -1 };
  }
  const button = ['left', 'middle', 'right', 'none'][b & 3];
  if (b & 32) return { kind: 'mouse', action: 'move', button, col, row, delta: 0 };
  return { kind: 'mouse', action: pressed ? 'press' : 'release', button, col, row, delta: 0 };
}

// --- Events → DevTools Input methods ---------------------------------------------

const KEY_CODES = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Insert: { code: 'Insert', vk: 45 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
};

const MOD_ALT = 1;
const MOD_CTRL = 2;

/**
 * The DevTools calls one event asks for, as `[method, params]` pairs. Text is
 * inserted whole; a named key or a chord is a keyDown/keyUp pair; a mouse
 * event lands on the middle of its cell, in the page's pixels.
 */
function toCdp(event, cell = DEFAULT_CELL) {
  switch (event.kind) {
    case 'text':
      return [['Input.insertText', { text: event.text }]];
    case 'key': {
      const named = KEY_CODES[event.key];
      const modifiers = (event.ctrl ? MOD_CTRL : 0) | (event.alt ? MOD_ALT : 0);
      const key = named ? event.key : event.key;
      const code = named ? named.code : `Key${event.key.toUpperCase()}`;
      const vk = named ? named.vk : event.key.toUpperCase().charCodeAt(0);
      const down = { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers };
      if (named && named.text) down.text = named.text;
      return [
        ['Input.dispatchKeyEvent', down],
        [
          'Input.dispatchKeyEvent',
          { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers },
        ],
      ];
    }
    case 'mouse': {
      const { x, y } = cellToPixel(event.col, event.row, cell);
      if (event.action === 'wheel') {
        return [
          [
            'Input.dispatchMouseEvent',
            { type: 'mouseWheel', x, y, deltaX: 0, deltaY: event.delta * cell.height * 3 },
          ],
        ];
      }
      const type = { press: 'mousePressed', release: 'mouseReleased', move: 'mouseMoved' }[
        event.action
      ];
      const params = {
        type,
        x,
        y,
        button: event.button,
        clickCount: event.action === 'move' ? 0 : 1,
      };
      if (event.action === 'move' && event.button !== 'none')
        params.buttons = { left: 1, right: 2, middle: 4 }[event.button];
      // A press lands where the pointer is, so the pointer is put there
      // first: a press with no move before it is one the page may not see.
      if (event.action === 'press') {
        return [
          ['Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }],
          ['Input.dispatchMouseEvent', params],
        ];
      }
      return [['Input.dispatchMouseEvent', params]];
    }
    default:
      return [];
  }
}

module.exports = {
  DEFAULT_CELL,
  ENTER,
  LEAVE,
  cellToPixel,
  kittyFrame,
  parseInput,
  passthrough,
  statusLine,
  toCdp,
  viewportFor,
};
