import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createActor, createMachine, type AnyActorRef } from 'xstate';
import { createKeyboardActor } from '../keyboardActor';
import * as mobileKeyboard from '../../../utils/mobileKeyboard';

type RecordedEvent = { type: string; [key: string]: unknown };

interface KeyboardActorHandle {
  actor: AnyActorRef;
  child: AnyActorRef;
  events: RecordedEvent[];
}

/**
 * Spawn the keyboard actor under a tiny parent that records every event it
 * sends and exposes a context snapshot (the actor reads activePaneId /
 * copyModeStates off the parent snapshot for copy-mode detection).
 */
function spawnKeyboardActor(activePaneId = '%3'): KeyboardActorHandle {
  const events: RecordedEvent[] = [];
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

function lastSendCommand(events: RecordedEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'SEND_TMUX_COMMAND') return events[i].command as string;
  }
  return undefined;
}

function sendCommands(events: RecordedEvent[]): string[] {
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
  let handle: KeyboardActorHandle;

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

describe('keyboardActor — Tab / Shift-Tab', () => {
  let handle: KeyboardActorHandle;
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
