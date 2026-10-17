/**
 * TmuxStatusBar - Bottom status bar with keybinding hints, host, and session
 *
 * Layout: [left: hints] [center: status messages] [right: host + session]
 *
 * - The left side follows the mode: normal-mode hints, or a mode's name as an
 *   inverse chip and its keys (PREFIX, COPY, and the sticky PANE and TAB
 *   tables). In a mode the host and session are hidden — the line is the
 *   mode's until it ends (statusLineHints.ts).
 * - Command mode replaces the whole bar with a full-width prompt input (like tmux prefix+:)
 * - Center shows only the client's own temporary status ("Copied …"); the raw
 *   tmux status line is NOT rendered — hardcoded hints (left) and host/session
 *   (right) stand in. tmux's `display-message` output goes to the snackbar.
 * - Host is clickable (desktop: open the connect float); session opens the session float
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import {
  useAppSelector,
  useAppSend,
  useAppConfig,
  selectCommandMode,
  selectStatusMessage,
  selectGridDimensions,
  selectSessionName,
  selectKeyBindings,
  selectPrefixActive,
  selectKeyTable,
  selectActivePaneCopyMode,
  useReadOnly,
} from '../machines/AppContext';
import { formatPrefixKey } from './menus/keybindingLabel';
import { HINT_SEPARATOR, MODE_HINTS, normalHints, type Hint } from './statusLineHints';
import { SessionMenu } from './SessionMenu';
import { isTauri } from '../utils/platform';
import type { KeyBindings } from '../machines/types';

function Separator() {
  return <span className="statusline-separator">{HINT_SEPARATOR}</span>;
}

/**
 * One line of hints: in a mode, its name as an inverse chip and then its
 * keys; in normal mode, the keys alone. See statusLineHints.ts for what each
 * mode says and the 80-column rule.
 */
function HintLine({ hints, mode }: { hints: readonly Hint[]; mode: string | null }) {
  return (
    <span
      className="statusline-hints"
      data-testid="statusline-hints"
      data-key-mode={mode ?? 'normal'}
    >
      {mode && <span className="statusline-mode">{mode.toUpperCase()}</span>}
      {hints.map((hint, i) => (
        <span key={hint.key}>
          {(mode || i > 0) && <Separator />}
          <span className="statusline-bracket">[</span>
          <kbd>{hint.key}</kbd>
          <span className="statusline-bracket">]</span>{' '}
          <span className="statusline-hint-desc">{hint.label}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * The status line's label for directional pane nav — `ctrl+hjkl` for the default
 * bindings — or null when nothing is bound to it.
 *
 * Read from the bindings rather than written down here, because the key is
 * config: the default is Ctrl+hjkl, and a user's own `~/.tmux.conf` may move it
 * somewhere else. The four
 * directions have to share one modifier and spell one word for a single hint to
 * be honest about them; anything else is left to the keybindings view.
 */
function navHintKey(rootBindings: KeyBindings['root_bindings']): string | null {
  const isNav = (command: string) => command.includes('tmuxy-nav') || command.includes('tmuxy/nav');
  const bound = new Map(
    rootBindings.filter((b) => isNav(b.command)).map((b) => [b.key, b.command] as const),
  );

  for (const modifier of ['C', 'M']) {
    const keys = ['h', 'j', 'k', 'l'];
    if (keys.every((key) => bound.has(`${modifier}-${key}`))) {
      return `${modifier === 'C' ? 'ctrl' : 'alt'}+${keys.join('')}`;
    }
  }
  return null;
}

/** The keys a mode lists: its own, or none for a table the line knows nothing about. */
function modeHints(mode: string): readonly Hint[] {
  return MODE_HINTS[mode] ?? [];
}

function CommandModeInput({
  prompt,
  input,
  gridWidth,
  send,
}: {
  prompt: string;
  input: string;
  gridWidth: number;
  send: ReturnType<typeof useAppSend>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        send({ type: 'COMMAND_MODE_SUBMIT', value: inputRef.current?.value ?? '' });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        send({ type: 'COMMAND_MODE_CANCEL' });
      }
    },
    [send],
  );

  return (
    <div className="tmux-status-bar tmux-command-mode" data-testid="tmux-command-mode">
      <div className="tmux-command-input-wrapper" style={{ width: gridWidth }}>
        <span className="tmux-command-prompt">{prompt}</span>
        <input
          ref={inputRef}
          className="tmux-command-input"
          type="text"
          defaultValue={input}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

export function TmuxStatusBar() {
  const commandMode = useAppSelector(selectCommandMode);
  const statusMessage = useAppSelector(selectStatusMessage);
  const { totalWidth, charWidth } = useAppSelector(selectGridDimensions);
  const sessionName = useAppSelector(selectSessionName);
  const keybindings = useAppSelector(selectKeyBindings);
  const prefixActive = useAppSelector(selectPrefixActive);
  const keyTable = useAppSelector(selectKeyTable);
  const inCopyMode = useAppSelector(selectActivePaneCopyMode);
  const send = useAppSend();
  const readOnly = useReadOnly();
  const { isDemo } = useAppConfig();
  const switcherRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const gridPixelWidth = totalWidth * charWidth;

  // Command mode: full-width input replaces everything
  if (commandMode) {
    return (
      <CommandModeInput
        prompt={commandMode.prompt}
        input={commandMode.input}
        gridWidth={gridPixelWidth}
        send={send}
      />
    );
  }

  const hostname = isDemo
    ? 'demo@localhost'
    : isTauri()
      ? 'localhost'
      : window.location.hostname || 'localhost';

  // Both ends of the status line open the same switcher (components/
  // SessionMenu): the host and the session name are two halves of "where am
  // I", so they answer with one menu rather than two prompts that knew nothing
  // of each other. It hangs from the pair and opens UPWARD — the status line
  // is the window's last row, so a menu below it would be off the screen.
  const handleSwitcherClick =
    isDemo || readOnly
      ? undefined
      : () => {
          if (!menuOpen) send({ type: 'SESSION_MENU_OPENED' });
          setMenuOpen(!menuOpen);
        };

  // Center area: only the client's own temporary status ("Copied …").
  // The tmux status line content is not displayed — we use hardcoded hints (left)
  // and hostname/session (right) instead.
  const centerContent = statusMessage ? (
    <pre className="tmux-status-bar-content tmux-status-message">{statusMessage.text}</pre>
  ) : null;

  // The mode in force, by the table it is: a sticky table (PANE, TAB), else
  // the prefix, else copy mode. While one is on the line is the mode's.
  const mode = keyTable ?? (prefixActive ? 'prefix' : inCopyMode ? 'copy' : null);
  // The nav hint names whatever key is actually bound: a user's own config
  // may move it off the default.
  const hints = mode
    ? modeHints(mode)
    : keybindings
      ? normalHints(formatPrefixKey(keybindings.prefix_key), navHintKey(keybindings.root_bindings))
      : null;

  return (
    <div className="tmux-status-bar" data-testid="tmux-status-bar">
      {/* Full width, whatever the pane grid measures: with a sidebar open the
          grid is narrower than the window, but the hints stay at the window's
          left edge and the host/session at its right. */}
      <div className="tmux-statusline-inner">
        <div className="tmux-statusline-left">
          {hints && <HintLine hints={hints} mode={mode} />}
        </div>
        <div className="tmux-statusline-center">{centerContent}</div>
        <div className="tmux-statusline-right" ref={switcherRef} hidden={mode !== null}>
          <span
            className={`statusline-host${handleSwitcherClick ? ' statusline-clickable' : ''}`}
            onClick={handleSwitcherClick}
          >
            {hostname}
          </span>
          <span
            className={`statusline-session${handleSwitcherClick ? ' statusline-clickable' : ''}`}
            onClick={handleSwitcherClick}
          >
            [{sessionName}]
          </span>
          {menuOpen && <SessionMenu anchorRef={switcherRef} onClose={() => setMenuOpen(false)} />}
        </div>
      </div>
    </div>
  );
}
