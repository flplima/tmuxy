import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pid } from '../../../test/wire';
import { createActor, createMachine, type AnyActorRef } from 'xstate';
import { createKeyboardActor } from '../keyboardActor';
import { toTmuxCommand, type TmuxOp } from '../../../domain/commands';
import * as mobileKeyboard from '../../../utils/mobileKeyboard';

function spawnKeyboardActor(activePaneId = pid('%3')) {
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

function wireCommand(event: { type: string; [k: string]: unknown }): string | undefined {
  if (event.type === 'SEND_TMUX_COMMAND') return event.command as string;
  if (event.type === 'DISPATCH_OP') return toTmuxCommand(event.op as TmuxOp);
  return undefined;
}

function sendCommands(events: Array<{ type: string; [k: string]: unknown }>): string[] {
  return events.map(wireCommand).filter((command): command is string => command !== undefined);
}

function lastSendCommand(
  events: Array<{ type: string; [k: string]: unknown }>,
): string | undefined {
  const commands = sendCommands(events);
  return commands[commands.length - 1];
}

describe('keyboardActor — composed characters are literal text', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  beforeEach(() => {
    handle = spawnKeyboardActor(pid('%3'));
  });

  it('sends a dead-key character even though the IME stamped it keyCode 229', () => {
    pressKey({ key: 'Dead', keyCode: 229 });
    pressKey({ key: 'á', keyCode: 229 });
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l -- 'á'");
  });

  it('still suppresses a key the IME is only processing (no character yet)', () => {
    pressKey({ key: 'x' });
    pressKey({ key: 'Process', keyCode: 229 });
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l -- 'x'");
  });

  it('sends a macOS Option-composed character instead of an M- chord', () => {
    pressKey({ key: 'ç', altKey: true });
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l -- 'ç'");
  });

  it('sends an AltGr third-level symbol instead of a C-M- chord', () => {
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
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l -- '@'");
  });

  it('sends IME-composed text as one literal on compositionend', () => {
    window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    pressKey({ key: 'n', keyCode: 229, isComposing: true });
    window.dispatchEvent(new CompositionEvent('compositionend', { data: '日本語', bubbles: true }));
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l -- '日本語'");
  });

  it('sends an emoji from the picker as one character', () => {
    window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    window.dispatchEvent(new CompositionEvent('compositionend', { data: '😀', bubbles: true }));
    expect(lastSendCommand(handle.events)).toBe("send-keys -t %3 -l -- '😀'");
  });
});

describe('keyboardActor — chords stay chords', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  beforeEach(() => {
    handle = spawnKeyboardActor(pid('%3'));
  });

  it('keeps bare Alt + an ASCII key as M-<key>', () => {
    pressKey({ key: 'x', altKey: true });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 M-x');
  });

  it('keeps Ctrl + a key as C-<key>', () => {
    pressKey({ key: 'g', ctrlKey: true });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 C-g');
  });

  it('keeps the macOS Option+h character mapped to M-h', () => {
    pressKey({ key: '˙', altKey: true });
    expect(lastSendCommand(handle.events)).toBe('send-keys -t %3 M-h');
  });
});

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
    handle = spawnKeyboardActor(pid('%3'));
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

    handle = spawnKeyboardActor(pid('%4'));

    expect(document.activeElement).toBe(textarea);
    textarea.remove();
  });

  it('leaves a paste into a real form control in the browser', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    handle.events.length = 0;

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => 'New name' },
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(sendCommands(handle.events)).toEqual([]);
    input.remove();

    pasteText('for the pane');
    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l -- 'for the pane'"]);
  });

  it('leaves composition from a real form control in the browser', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    handle.events.length = 0;

    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한글' }));
    pressKey({ key: 'x' });

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l -- 'x'"]);
    textarea.remove();
  });

  it('waits for a user gesture before focusing on a touch device', () => {
    handle.actor.stop();
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    input.blur();
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });

    handle = spawnKeyboardActor(pid('%3'));

    expect(document.activeElement).not.toBe(input);
    mobileKeyboard.focusMobileInput(pid('%3'));
    expect(document.activeElement).toBe(input);
  });

  it('supports mouse or keyboard focus on a touch-capable hybrid device', () => {
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;

    mobileKeyboard.focusKeyboardInput(pid('%3'));
    expect(document.activeElement).toBe(input);

    input.blur();
    mobileKeyboard.focusMobileInput(pid('%3'));
    expect(document.activeElement).toBe(input);

    mobileKeyboard.focusMobileInput(pid('%3'));
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

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l -- 'a'"]);
  });

  it('routes hidden-input text to an active pane selected after focus moved', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    mobileKeyboard.focusKeyboardInput(pid('%3'));

    handle.child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: pid('%4') });
    insertText(input, 'b');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %4 -l -- 'b'"]);
  });

  it('routes hidden-input text to a newly focused float pane', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    mobileKeyboard.focusKeyboardInput(pid('%3'));

    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: pid('%9') });
    insertText(input, 'f');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %9 -l -- 'f'"]);
  });

  it('returns hidden-input text to the active pane after a float loses focus', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: pid('%9') });
    mobileKeyboard.focusKeyboardInput(pid('%9'));

    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: null });
    insertText(input, 'r');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l -- 'r'"]);
  });

  it('keeps printable prefix bindings active while the hidden input owns focus', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    handle.child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        tables: {},
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
        tables: {},
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
        tables: {},
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
    expect(handle.events).toContainEqual({
      type: 'PREFIX_MODE_CHANGE',
      active: true,
      repeatOnly: null,
    });
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
    mobileKeyboard.focusKeyboardInput(pid('%3'));

    startComposition(input, ['ㅎ']);
    commitComposition(input, '한글');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l -- '한글'"]);
  });

  it('commits hidden-input composition to the pane where composition started', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    mobileKeyboard.focusKeyboardInput(pid('%3'));
    startComposition(input, ['ㅎ']);

    handle.child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: pid('%4') });
    mobileKeyboard.focusKeyboardInput(pid('%4'));
    commitComposition(input, '한');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l -- '한'"]);
  });

  it('pins hidden-input composition to the actor target at composition start', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    mobileKeyboard.focusKeyboardInput(pid('%3'));
    handle.child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: pid('%4') });
    startComposition(input, ['ㅎ']);

    handle.child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: pid('%5') });
    commitComposition(input, '한');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %4 -l -- '한'"]);
  });

  it('commits non-input composition to the pane where composition started', () => {
    window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    handle.child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: pid('%4') });
    window.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' }));

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l -- '한'"]);
  });

  it('forwards committed Hangul to the focused float pane', () => {
    const input = mobileKeyboard.getMobileInput();
    expect(input).not.toBeNull();
    if (!input) return;
    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: pid('%9') });
    mobileKeyboard.focusKeyboardInput(pid('%9'));

    startComposition(input, ['ㅎ']);
    commitComposition(input, '한');

    expect(sendCommands(handle.events)).toEqual(["send-keys -t %9 -l -- '한'"]);
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
    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: pid('%9') });
    commitComposition(input, '한');
    handle.child.send({ type: 'UPDATE_FOCUSED_FLOAT', paneId: placeholder });
    pasteText('붙여넣기');

    expect(sendCommands(handle.events)).toEqual([
      "send-keys -t tmuxy -l -- 'x'",
      'send-keys -t tmuxy Tab',
      "send-keys -t tmuxy -l -- '한'",
      "send-keys -t tmuxy -l -- '붙여넣기'",
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
        tables: {},
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
