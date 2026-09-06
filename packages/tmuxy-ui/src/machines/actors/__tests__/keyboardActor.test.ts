import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createActor, createMachine, assign, type AnyActorRef } from 'xstate';
import { createKeyboardActor } from '../keyboardActor';
import * as mobileKeyboard from '../../../utils/mobileKeyboard';

/**
 * Spawn the keyboard actor under a tiny parent that records every event it
 * sends and exposes a context snapshot (the actor reads activePaneId /
 * copyModeStates off the parent snapshot for copy-mode detection).
 */
function spawnKeyboardActor(activePaneId = '%3') {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const keyboardActor = createKeyboardActor();
  const parent = createMachine({
    types: {} as {
      context: { activePaneId: string; copyModeStates: Record<string, unknown> };
      events: { type: string; [k: string]: unknown };
    },
    context: { activePaneId, copyModeStates: {} },
    invoke: {
      id: 'keyboard',
      src: 'keyboardActor',
      input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
    },
    on: {
      '*': {
        actions: ({ event }) => {
          events.push(event as { type: string; [k: string]: unknown });
        },
      },
    },
  }).provide({ actors: { keyboardActor }, actions: {} } as never);

  const actor = createActor(parent);
  actor.start();
  const child = actor.getSnapshot().children.keyboard as AnyActorRef;
  child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: activePaneId });
  return { actor, child, events };
}

function pressKey(init: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function lastSendCommand(
  events: Array<{ type: string; [k: string]: unknown }>,
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'SEND_TMUX_COMMAND') return events[i].command as string;
  }
  return undefined;
}

describe('keyboardActor — Tab / Shift-Tab', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  beforeEach(() => {
    handle = spawnKeyboardActor('%3');
  });

  it('sends plain Tab as the tmux key "Tab"', () => {
    pressKey({ key: 'Tab' });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 Tab');
  });

  it('sends Shift+Tab as the tmux back-tab key "BTab" (not S-Tab)', () => {
    // tmux emits a literal Tab (0x09) for the key name "S-Tab"; only "BTab"
    // produces the CSI Z back-tab sequence applications expect for Shift+Tab.
    pressKey({ key: 'Tab', shiftKey: true });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 BTab');
  });
});

/**
 * Spawn the actor under a parent whose `activePaneId` can be reassigned WITHOUT
 * notifying the child. This mirrors a pane-group tab click: the machine's
 * `assign({ activePaneId })` runs synchronously in the transition, but the
 * `UPDATE_ACTIVE_PANE` event that refreshes the actor's cached closure is
 * delivered a task later. The actor must read the live value off the parent
 * snapshot, not its stale closure, or the first keystroke after the click
 * targets the previously-active pane.
 */
function spawnWithLiveContext(initial = '%1') {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const keyboardActor = createKeyboardActor();
  const parent = createMachine({
    types: {} as {
      context: {
        activePaneId: string;
        activeWindowId: string;
        copyModeStates: Record<string, unknown>;
        panes: Array<{ tmuxId: string; windowId: string; active: boolean }>;
      };
      events: { type: string; paneId?: string; windowId?: string; [k: string]: unknown };
    },
    context: {
      activePaneId: initial,
      activeWindowId: '@0',
      copyModeStates: {},
      // Two tabs: @0 holds %1 (active) and %2; @1 holds %3.
      panes: [
        { tmuxId: '%1', windowId: '@0', active: true },
        { tmuxId: '%2', windowId: '@0', active: false },
        { tmuxId: '%3', windowId: '@1', active: true },
      ],
    },
    invoke: {
      id: 'keyboard',
      src: 'keyboardActor',
      input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
    },
    on: {
      // Test-only: flip the machine's activePaneId the way a tab click does,
      // deliberately WITHOUT sending UPDATE_ACTIVE_PANE to the child.
      SET_PARENT_ACTIVE: {
        actions: assign({ activePaneId: ({ event }) => event.paneId as string }),
      },
      // Test-only: the machine's active window, as a tab switch sets it.
      SET_PARENT_WINDOW: {
        actions: assign({ activeWindowId: ({ event }) => event.windowId as string }),
      },
      '*': {
        actions: ({ event }) => {
          events.push(event as { type: string; [k: string]: unknown });
        },
      },
    },
  }).provide({ actors: { keyboardActor }, actions: {} } as never);

  const actor = createActor(parent);
  actor.start();
  const child = actor.getSnapshot().children.keyboard as AnyActorRef;
  // Sync the child's cached closure to the initial pane, as the real app does.
  child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: initial });
  return { actor, child, events };
}

describe('keyboardActor — active-pane target uses the live snapshot', () => {
  it('targets the newly-active pane even before UPDATE_ACTIVE_PANE arrives', () => {
    const { actor, events } = spawnWithLiveContext('%1');

    // Tab click: machine context flips synchronously; the child closure is NOT
    // refreshed (no UPDATE_ACTIVE_PANE), exactly as in the same-tick race.
    actor.send({ type: 'SET_PARENT_ACTIVE', paneId: '%2' });

    // A printable key fired in this same tick must reach %2, not the stale
    // %1 (sent literally as `-l 'a'`).
    pressKey({ key: 'a' });
    expect(lastSendCommand(events)).toBe("send-keys -t %2 -l 'a'");
  });

  it('falls back to the cached pane when the snapshot has no activePaneId', () => {
    // Defends the try/catch fallback: a parent that never carries activePaneId
    // must not break key routing — the cached closure value still applies.
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const keyboardActor = createKeyboardActor();
    const parent = createMachine({
      types: {} as {
        context: Record<string, never>;
        events: { type: string; [k: string]: unknown };
      },
      context: {},
      invoke: {
        id: 'keyboard',
        src: 'keyboardActor',
        input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
      },
      on: {
        '*': { actions: ({ event }) => events.push(event as { type: string }) },
      },
    }).provide({ actors: { keyboardActor }, actions: {} } as never);
    const actor = createActor(parent);
    actor.start();
    const child = actor.getSnapshot().children.keyboard as AnyActorRef;
    child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: '%7' });

    pressKey({ key: 'b' });
    expect(lastSendCommand(events)).toBe("send-keys -t %7 -l 'b'");
  });
});

describe('keyboardActor — bindings are pinned to the window the user sees', () => {
  it('prepends select-window and select-pane to prefix and root bindings', () => {
    // A split right after a tab switch: the client is already on the new tab
    // (optimistically) while tmux may still be on the old one. `select-pane`
    // alone never changes the current window, so without the window pin the
    // split could land in the tab the user just left.
    const { actor, child, events } = spawnWithLiveContext('%1');
    child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        prefix_bindings: [{ key: '%', command: 'split-window -h', repeat: false }],
        root_bindings: [{ key: 'C-n', command: 'next-window' }],
      },
    });
    actor.send({ type: 'SET_PARENT_ACTIVE', paneId: '%2' });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });
    expect(lastSendCommand(events)).toBe(
      'select-window -t @0 \\; select-pane -t %2 \\; split-window -h',
    );

    pressKey({ key: 'n', ctrlKey: true });
    expect(lastSendCommand(events)).toBe(
      'select-window -t @0 \\; select-pane -t %2 \\; next-window',
    );
  });

  it("never pins a pane outside the pinned window: the window's own active pane stands in", () => {
    // `select-pane` on a pane in another tab also re-points the command list's
    // current target at it, so `split-window` after it would land in THAT tab
    // (seen in the wild: a stale active-pane id from the initial snapshot,
    // tab 2 on screen, the split appeared in tab 1).
    const { actor, child, events } = spawnWithLiveContext('%1');
    child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        prefix_bindings: [{ key: '%', command: 'split-window -h', repeat: false }],
        root_bindings: [],
      },
    });
    // The machine shows tab @1 while its active pane id still points into @0.
    actor.send({ type: 'SET_PARENT_WINDOW', windowId: '@1' });
    actor.send({ type: 'SET_PARENT_ACTIVE', paneId: '%2' });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });
    expect(lastSendCommand(events)).toBe(
      'select-window -t @1 \\; select-pane -t %3 \\; split-window -h',
    );

    // A window whose panes are not known yet is pinned on its own.
    actor.send({ type: 'SET_PARENT_WINDOW', windowId: '@2' });
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: '%', shiftKey: true });
    expect(lastSendCommand(events)).toBe('select-window -t @2 \\; split-window -h');
  });
});

describe('keyboardActor — ctrl+digit is the tab strip, not a tmux binding', () => {
  it('sends the strip position for ctrl+1–9 and toggles the overview on ctrl+0', () => {
    // Sidebars and floats occupy tmux window indexes the user never sees, so
    // `select-window -t N` would pick the wrong tab. The client resolves the
    // Nth visible tab itself; a root binding on the same key never wins.
    const { child, events } = spawnWithLiveContext('%1');
    child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        prefix_bindings: [],
        root_bindings: [{ key: 'C-2', command: 'select-window -t 2' }],
      },
    });

    const ofType = (type: string) => events.filter((e) => e.type === type);

    pressKey({ key: '2', ctrlKey: true });
    expect(ofType('SELECT_TAB_BY_POSITION')).toEqual([
      { type: 'SELECT_TAB_BY_POSITION', position: 2 },
    ]);
    expect(ofType('SEND_COMMAND')).toEqual([]);

    pressKey({ key: '0', ctrlKey: true });
    expect(ofType('TOGGLE_TAB_OVERVIEW')).toHaveLength(1);

    // prefix w opens the same overview.
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'w' });
    expect(ofType('TOGGLE_TAB_OVERVIEW')).toHaveLength(2);
  });
});

describe('keyboardActor — prefix mode', () => {
  afterEach(() => vi.useRealTimers());

  const lastPrefixActive = (
    events: Array<{ type: string; [k: string]: unknown }>,
  ): boolean | undefined => {
    const actives = events
      .filter((e) => e.type === 'PREFIX_MODE_CHANGE')
      .map((e) => e.active as boolean);
    return actives[actives.length - 1];
  };

  it('entering prefix mode (Ctrl+A) announces PREFIX_MODE_CHANGE active', () => {
    const { events } = spawnKeyboardActor('%3');
    pressKey({ key: 'a', ctrlKey: true });
    expect(lastPrefixActive(events)).toBe(true);
  });

  it('auto-exits prefix mode after the timeout', () => {
    vi.useFakeTimers();
    const { events } = spawnKeyboardActor('%3');
    pressKey({ key: 'a', ctrlKey: true });
    expect(lastPrefixActive(events)).toBe(true);
    // The 8s prefix window elapses with no binding pressed.
    vi.advanceTimersByTime(8000);
    expect(lastPrefixActive(events)).toBe(false);
  });

  it('double prefix exits prefix mode and sends the literal prefix key', () => {
    const { events } = spawnKeyboardActor('%3');
    pressKey({ key: 'a', ctrlKey: true }); // enter
    pressKey({ key: 'a', ctrlKey: true }); // double → exit + literal
    expect(lastPrefixActive(events)).toBe(false);
    expect(lastSendCommand(events)).toBe('send-keys -t %3 C-a');
  });
});

/**
 * International input: the character a layout composed must be forwarded as
 * literal text (`send-keys -l`). As a key name it is not an error but worse:
 * tmux turns `M-ç` into ESC + ç and `C-M-@` into ESC + NUL, meta sequences the
 * shell discards, so the character silently never arrives. The three composed
 * paths below all wear flags that read like a chord, so the actor has to tell
 * them apart from the real chords in the last block.
 */
describe('keyboardActor — composed characters are literal text', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  beforeEach(() => {
    handle = spawnKeyboardActor('%3');
  });

  it('sends a dead-key character even though the IME stamped it keyCode 229', () => {
    // ´ then a on a Portuguese/US-International layout: the accent key yields
    // `Dead`, and the next keydown already carries the composed `á`. macOS
    // routes that through the IME, so it wears the 229 "IME is handling this"
    // marker that suppresses genuinely mid-composition keys.
    pressKey({ key: 'Dead', keyCode: 229 });
    pressKey({ key: 'á', keyCode: 229 });
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l 'á'");
  });

  it('still suppresses a key the IME is only processing (no character yet)', () => {
    pressKey({ key: 'x' });
    pressKey({ key: 'Process', keyCode: 229 });
    // The last command is still the `x` before it — `Process` sent nothing.
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l 'x'");
  });

  it('sends a macOS Option-composed character instead of an M- chord', () => {
    // Option+c on a US Mac layout: altKey is set, but the OS already replaced
    // the letter with `ç`.
    pressKey({ key: 'ç', altKey: true });
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l 'ç'");
  });

  it('sends an AltGr third-level symbol instead of a C-M- chord', () => {
    // AltGr+Q on ABNT2 → `@`, reported with the legacy ctrl+alt flags plus the
    // AltGraph modifier state that identifies it.
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '@',
        ctrlKey: true,
        altKey: true,
        modifierAltGraph: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l '@'");
  });

  it('sends IME-composed text as one literal on compositionend', () => {
    window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    pressKey({ key: 'n', keyCode: 229, isComposing: true });
    window.dispatchEvent(new CompositionEvent('compositionend', { data: '日本語', bubbles: true }));
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l '日本語'");
  });

  it('sends an emoji from the picker as one character', () => {
    window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    window.dispatchEvent(new CompositionEvent('compositionend', { data: '😀', bubbles: true }));
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l '😀'");
  });
});

describe('keyboardActor — chords stay chords', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  beforeEach(() => {
    handle = spawnKeyboardActor('%3');
  });

  it('keeps bare Alt + an ASCII key as M-<key>', () => {
    // Nothing was composed — the key is still `x` — so this is a real chord.
    pressKey({ key: 'x', altKey: true });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 M-x');
  });

  it('keeps Ctrl + a key as C-<key>', () => {
    pressKey({ key: 'g', ctrlKey: true });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 C-g');
  });

  it('keeps the macOS Option+h character mapped to M-h', () => {
    // Option+h yields `˙`, which tmuxy claims for pane navigation rather than
    // typing — the one non-ASCII-under-Alt case that is NOT text.
    pressKey({ key: '˙', altKey: true });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 M-h');
  });
});

// ---------------------------------------------------------------------------
// Desktop IME: the hidden input owns browser focus and follows the pane
// holding the keyboard (from PR #61 by @devcomfort).
// ---------------------------------------------------------------------------

function sendCommands(events: Array<{ type: string; [k: string]: unknown }>): string[] {
  return events
    .filter((event) => event.type === 'SEND_TMUX_COMMAND')
    .map((event) => event.command as string);
}

function startComposition(input: HTMLInputElement, texts: string[]) {
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  for (const text of texts) {
    input.value = text;
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: text,
        inputType: 'insertCompositionText',
        isComposing: true,
      }),
    );
  }
}

function commitComposition(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
  input.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      data: text,
      inputType: 'insertText',
      isComposing: false,
    }),
  );
}

function insertText(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      data: text,
      inputType: 'insertText',
    }),
  );
}

function pasteText(text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
  window.dispatchEvent(event);
}

describe('keyboardActor — desktop IME', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;

  beforeEach(() => {
    delete (window as Window & { ontouchstart?: unknown }).ontouchstart;
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
    handle = spawnKeyboardActor('%3');
  });

  afterEach(() => {
    handle.actor.stop();
    const input = mobileKeyboard.getMobileInput();
    if (input) {
      input.value = '';
      input.blur();
    }
  });

  it('installs an editable input in a non-touch browser', () => {
    const input = mobileKeyboard.getMobileInput();

    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input?.isConnected).toBe(true);
  });

  it('focuses the editable input when the first active pane arrives', () => {
    const input = mobileKeyboard.getMobileInput();

    expect(document.activeElement).toBe(input);
  });

  it('does not steal initial focus from a real form control', () => {
    handle.actor.stop();
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    handle = spawnKeyboardActor('%4');

    expect(document.activeElement).toBe(textarea);
    textarea.remove();
  });

  it('leaves composition from a real form control in the browser', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    handle.events.length = 0;

    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한글' }));
    pressKey({ key: 'x' });

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l 'x'"]);
    textarea.remove();
  });

  it('waits for a user gesture before focusing on a touch device', () => {
    handle.actor.stop();
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    input.blur();
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });

    handle = spawnKeyboardActor('%3');

    expect(document.activeElement).not.toBe(input);
    mobileKeyboard.focusMobileInput('%3');
    expect(document.activeElement).toBe(input);
  });

  it('supports mouse or keyboard focus on a touch-capable hybrid device', () => {
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;

    mobileKeyboard.focusKeyboardInput('%3');
    expect(document.activeElement).toBe(input);

    input.blur();
    mobileKeyboard.focusMobileInput('%3');
    expect(document.activeElement).toBe(input);

    mobileKeyboard.focusMobileInput('%3');
    expect(document.activeElement).not.toBe(input);
  });

  it('forwards ordinary desktop text exactly once through the hidden input', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;

    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    input.value = 'a';
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: 'a',
        inputType: 'insertText',
      }),
    );

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l 'a'"]);
  });

  it('routes hidden-input text to an active pane selected after focus moved', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    mobileKeyboard.focusKeyboardInput('%3');

    handle.child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: '%4' });
    insertText(input, 'b');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %4 -l 'b'"]);
  });

  it('routes hidden-input text to a newly focused float pane', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    mobileKeyboard.focusKeyboardInput('%3');

    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: '%9' });
    insertText(input, 'f');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %9 -l 'f'"]);
  });

  it('returns hidden-input text to the active pane after a float loses focus', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: '%9' });
    mobileKeyboard.focusKeyboardInput('%9');

    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: null });
    insertText(input, 'r');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l 'r'"]);
  });

  it('keeps printable prefix bindings active while the hidden input owns focus', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    handle.child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        prefix_bindings: [{ key: 'c', command: 'new-window', description: 'new window' }],
        root_bindings: [],
      },
    });

    input.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'a', ctrlKey: true }),
    );
    const bindingKey = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'c',
    });
    input.dispatchEvent(bindingKey);

    expect(bindingKey.defaultPrevented).toBe(true);
    expect(sendCommands(handle.events)).toEqual(['select-pane -t %3 \\; new-window']);
  });

  it('keeps printable root bindings active while the hidden input owns focus', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    handle.child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        prefix_bindings: [],
        root_bindings: [{ key: 'c', command: 'display-message root', description: 'root' }],
      },
    });

    const rootKey = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'c',
    });
    input.dispatchEvent(rootKey);

    expect(rootKey.defaultPrevented).toBe(true);
    expect(sendCommands(handle.events)).toEqual(['select-pane -t %3 \\; display-message root']);
  });

  it('cancels a printable prefix key before the hidden input emits text', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    handle.child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'a',
        prefix_bindings: [],
        root_bindings: [],
      },
    });

    const prefix = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'a',
    });
    input.dispatchEvent(prefix);
    if (!prefix.defaultPrevented) insertText(input, 'a');

    expect(prefix.defaultPrevented).toBe(true);
    expect(handle.events).toContainEqual({ type: 'PREFIX_MODE_CHANGE', active: true });
    expect(sendCommands(handle.events)).toEqual([]);
  });

  it('keeps the buffer intact while multiple jamo are composing', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;

    startComposition(input, ['ㅎ', '하', '한']);

    expect(input.value).toBe('한');
    expect(sendCommands(handle.events)).toEqual([]);
  });

  it('forwards committed Hangul exactly once', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    mobileKeyboard.focusKeyboardInput('%3');

    startComposition(input, ['ㅎ']);
    commitComposition(input, '한글');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l '한글'"]);
  });

  it('commits hidden-input composition to the pane where composition started', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    mobileKeyboard.focusKeyboardInput('%3');
    startComposition(input, ['ㅎ']);

    handle.child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: '%4' });
    mobileKeyboard.focusKeyboardInput('%4');
    commitComposition(input, '한');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l '한'"]);
  });

  it('pins hidden-input composition to the actor target at composition start', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    mobileKeyboard.focusKeyboardInput('%3');
    handle.child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: '%4' });
    startComposition(input, ['ㅎ']);

    handle.child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: '%5' });
    commitComposition(input, '한');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %4 -l '한'"]);
  });

  it('commits non-input composition to the pane where composition started', () => {
    window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    handle.child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: '%4' });
    window.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' }));

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l '한'"]);
  });

  it('forwards committed Hangul to the focused float pane', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: '%9' });
    mobileKeyboard.focusKeyboardInput('%9');

    startComposition(input, ['ㅎ']);
    commitComposition(input, '한');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %9 -l '한'"]);
  });

  it('drops a composition commit after keyboard forwarding is disabled', () => {
    window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    handle.child.send({ type: 'UPDATE_ENABLED', enabled: false });
    window.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' }));

    expect(sendCommands(handle.events)).toEqual([]);
  });

  it('falls back to the session for text, special keys, composition, and paste while a float is provisional', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    const placeholder = '__placeholder_float_1';
    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: placeholder });

    insertText(input, 'x');
    pressKey({ key: 'Tab' });
    startComposition(input, ['ㅎ']);
    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: '%9' });
    commitComposition(input, '한');
    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: placeholder });
    pasteText('붙여넣기');

    expect(sendCommands(handle.events)).toEqual([
      "send-keys -t tmuxy -l 'x'",
      'send-keys -t tmuxy Tab',
      "send-keys -t tmuxy -l '한'",
      "send-keys -t tmuxy -l '붙여넣기'",
    ]);
    expect(sendCommands(handle.events).join('\n')).not.toContain(placeholder);
  });

  it('never pins prefix or root commands to a provisional float id', () => {
    const placeholder = '__placeholder_float_1';
    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: placeholder });
    handle.child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        prefix_bindings: [{ key: 'c', command: 'new-window', description: 'new window' }],
        root_bindings: [
          { key: 'F2', command: 'display-message root', description: 'root binding' },
        ],
      },
    });

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'c' });
    pressKey({ key: 'F2' });
    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'a', ctrlKey: true });

    expect(sendCommands(handle.events)).toEqual([
      'new-window',
      'display-message root',
      'send-keys -t tmuxy C-a',
    ]);
    expect(sendCommands(handle.events).join('\n')).not.toContain(placeholder);
  });
});
