/**
 * `tmuxy widget browser` (also `tmuxy browser`): the dispatcher's wiring,
 * the help, the usage errors, and the pure mappings in browser-lib.js — a
 * pane's cells to the page's pixels, a screencast frame to Kitty graphics
 * tmux relays, and the bytes a pane delivers to DevTools input events.
 */

const path = require('path');
const { runCLI } = require('./helpers/run-cli');
const lib = require('../../packages/tmuxy-cli/bin/tmuxy/browser-lib.js');

const ESC = '\x1b';

describe('tmuxy widget browser: the command', () => {
  test.each([['browser'], ['widget', 'browser']])('%s --help describes the options', (...cmd) => {
    const { stdout, exitCode, tmuxCalls } = runCLI([...cmd, '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy widget browser [options] <url>');
    expect(stdout).toContain('--cdp <endpoint>');
    expect(stdout).toContain('Ctrl+Q');
    expect(tmuxCalls).toEqual([]);
  });

  test('a url is required', () => {
    const { stderr, exitCode, tmuxCalls } = runCLI(['browser']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('a url is required');
    expect(tmuxCalls).toEqual([]);
  });

  test('an unknown option is refused before anything starts', () => {
    const { stderr, exitCode, tmuxCalls } = runCLI(['widget', 'browser', '--bogus', 'https://x']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('Unknown option: --bogus');
    expect(tmuxCalls).toEqual([]);
  });

  test('says which node it needs when there is none', () => {
    const { stderr, exitCode } = runCLI(['browser', 'https://x'], {
      env: { TMUXY_NODE: path.join(__dirname, 'no-such-node') },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('node 22 or newer is required');
  });

  test('the top-level help lists it', () => {
    const { stdout } = runCLI(['--help']);
    expect(stdout).toContain('browser     Show a web page live in this pane');
    const widget = runCLI(['widget', '--help']).stdout;
    expect(widget).toContain('browser       Show a web page live');
  });
});

describe('browser-lib: cells and pixels', () => {
  test('the page is every row but the status line, 8×16 px a cell', () => {
    expect(lib.viewportFor(80, 24)).toEqual({ width: 640, height: 368, cols: 80, rows: 23 });
    expect(lib.viewportFor(100, 30, { width: 10, height: 20 })).toEqual({
      width: 1000,
      height: 580,
      cols: 100,
      rows: 29,
    });
  });

  test('a one-row pane still has a row for the picture', () => {
    expect(lib.viewportFor(10, 1).rows).toBe(1);
  });

  test('a cell maps to the pixel at its middle, 1-based as SGR counts', () => {
    expect(lib.cellToPixel(1, 1)).toEqual({ x: 4, y: 8 });
    expect(lib.cellToPixel(10, 5)).toEqual({ x: 76, y: 72 });
  });
});

describe('browser-lib: a frame as Kitty graphics', () => {
  test('wraps each chunk for tmux, every ESC doubled, and homes the cursor first', () => {
    const frame = lib.kittyFrame('QUJD', 80, 23);
    expect(frame.startsWith(`${ESC}[H`)).toBe(true);
    expect(frame).toContain(
      `${ESC}Ptmux;${ESC}${ESC}_Ga=T,f=100,q=2,c=80,r=23,m=0;QUJD${ESC}${ESC}\\${ESC}\\`,
    );
  });

  test('splits a long payload into 4096-byte chunks, m=1 until the last', () => {
    const payload = 'A'.repeat(4096 * 2 + 10);
    const frame = lib.kittyFrame(payload, 40, 10);
    const packets = frame.split(`${ESC}Ptmux;`).slice(1);
    expect(packets).toHaveLength(3);
    expect(packets[0]).toContain('c=40,r=10,m=1;');
    expect(packets[1]).toContain(`${ESC}${ESC}_Gm=1;`);
    expect(packets[2]).toContain(`${ESC}${ESC}_Gm=0;`);
    expect(packets[2]).toContain('A'.repeat(10) + `${ESC}${ESC}\\`);
  });

  test('passthrough doubles every ESC inside', () => {
    expect(lib.passthrough(`${ESC}_Gx${ESC}\\`)).toBe(
      `${ESC}Ptmux;${ESC}${ESC}_Gx${ESC}${ESC}\\${ESC}\\`,
    );
  });

  test('the status line fits the last row and keeps the way out', () => {
    const line = lib.statusLine(
      24,
      40,
      'A title',
      'https://example.com/a/very/long/path/that/overflows',
    );
    expect(line.startsWith(`${ESC}[24;1H${ESC}[7m`)).toBe(true);
    const text = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    expect(text).toHaveLength(40);
    expect(text.endsWith(' Ctrl+Q quits ')).toBe(true);
    expect(text).toContain('A title — https://');
  });
});

describe('browser-lib: what the pane delivers', () => {
  test('printable text, named keys, control chords and the quit key', () => {
    const { events, rest } = lib.parseInput(`ab\r\t\x7f${ESC}[A${ESC}[3~\x03\x11`);
    expect(rest).toBe('');
    expect(events).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'key', key: 'Enter', ctrl: false, alt: false },
      { kind: 'key', key: 'Tab', ctrl: false, alt: false },
      { kind: 'key', key: 'Backspace', ctrl: false, alt: false },
      { kind: 'key', key: 'ArrowUp', ctrl: false, alt: false },
      { kind: 'key', key: 'Delete', ctrl: false, alt: false },
      { kind: 'key', key: 'c', ctrl: true, alt: false },
      { kind: 'quit' },
    ]);
  });

  test('SGR mouse reports: press, release, drag, wheel', () => {
    const { events } = lib.parseInput(
      `${ESC}[<0;10;5M${ESC}[<0;10;5m${ESC}[<32;11;5M${ESC}[<64;3;3M${ESC}[<65;3;3M${ESC}[<2;1;1M`,
    );
    expect(events.map((e) => [e.action, e.button, e.col, e.row, e.delta])).toEqual([
      ['press', 'left', 10, 5, 0],
      ['release', 'left', 10, 5, 0],
      ['move', 'left', 11, 5, 0],
      ['wheel', 'none', 3, 3, -1],
      ['wheel', 'none', 3, 3, 1],
      ['press', 'right', 1, 1, 0],
    ]);
  });

  test('a sequence cut at the chunk end waits for the rest', () => {
    const first = lib.parseInput(`x${ESC}[<0;1`);
    expect(first.events).toEqual([{ kind: 'text', text: 'x' }]);
    expect(first.rest).toBe(`${ESC}[<0;1`);
    const second = lib.parseInput(`${first.rest}0;5M`);
    expect(second.events).toEqual([
      { kind: 'mouse', action: 'press', button: 'left', col: 10, row: 5, delta: 0 },
    ]);
    expect(lib.parseInput(ESC).rest).toBe(ESC);
  });

  test('a lone escape and Alt+key', () => {
    expect(lib.parseInput(`${ESC}${ESC}`).events[0]).toEqual({
      kind: 'key',
      key: 'Escape',
      ctrl: false,
      alt: false,
    });
    expect(lib.parseInput(`${ESC}x`).events[0]).toEqual({
      kind: 'key',
      key: 'x',
      ctrl: false,
      alt: true,
    });
  });
});

describe('browser-lib: events as DevTools input', () => {
  test('text is inserted whole', () => {
    expect(lib.toCdp({ kind: 'text', text: 'hi' })).toEqual([['Input.insertText', { text: 'hi' }]]);
  });

  test('Enter is a keyDown with its text and a keyUp', () => {
    const [[, down], [, up]] = lib.toCdp({ kind: 'key', key: 'Enter', ctrl: false, alt: false });
    expect(down).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
    });
    expect(up).toMatchObject({ type: 'keyUp', key: 'Enter' });
  });

  test('Ctrl+c is the letter with the control modifier', () => {
    const [[, down]] = lib.toCdp({ kind: 'key', key: 'c', ctrl: true, alt: false });
    expect(down).toMatchObject({ key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
  });

  test('a click lands on the middle of its cell; a wheel scrolls three rows', () => {
    const [[, moveFirst], [, press]] = lib.toCdp({
      kind: 'mouse',
      action: 'press',
      button: 'left',
      col: 10,
      row: 5,
      delta: 0,
    });
    expect(moveFirst).toMatchObject({ type: 'mouseMoved', x: 76, y: 72 });
    expect(press).toEqual({ type: 'mousePressed', x: 76, y: 72, button: 'left', clickCount: 1 });
    const [[, wheel]] = lib.toCdp({
      kind: 'mouse',
      action: 'wheel',
      button: 'none',
      col: 1,
      row: 1,
      delta: 1,
    });
    expect(wheel).toMatchObject({ type: 'mouseWheel', deltaY: 48 });
    const [[, drag]] = lib.toCdp({
      kind: 'mouse',
      action: 'move',
      button: 'left',
      col: 2,
      row: 2,
      delta: 0,
    });
    expect(drag).toMatchObject({ type: 'mouseMoved', buttons: 1, clickCount: 0 });
  });
});
