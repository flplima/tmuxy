/**
 * Command Parser
 *
 * Parses tmux commands to detect operation types for optimistic updates.
 * Returns parsed command info that can be used to calculate predictions.
 */

export type ParsedCommand = SplitCommand | NavigateCommand | SwapCommand | SelectPaneCommand | null;

export interface SplitCommand {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  targetPaneId?: string;
}

export interface NavigateCommand {
  type: 'navigate';
  direction: 'L' | 'R' | 'U' | 'D';
}

export interface SwapCommand {
  type: 'swap';
  sourcePaneId: string;
  targetPaneId: string;
}

export interface SelectPaneCommand {
  type: 'select-pane';
  paneId: string;
}

/**
 * Parse a tmux command string to detect operation type.
 *
 * Supported commands:
 * - `split-window -v` / `splitw -v` → vertical split (new pane on RIGHT)
 * - `split-window -h` / `splitw -h` → horizontal split (new pane BELOW)
 * - `select-pane -L/-R/-U/-D` / `selectp -L/-R/-U/-D` → navigation
 * - `swap-pane -s %X -t %Y` / `swapp -s %X -t %Y` → swap panes
 * - `select-pane -t %X` → focus pane
 */
export function parseCommand(command: string): ParsedCommand {
  const trimmed = command.trim();

  // Split command: split-window or splitw
  const splitMatch = trimmed.match(/^(split-window|splitw)\s+(-[hvV])/);
  if (splitMatch) {
    const flag = splitMatch[2].toLowerCase();
    // Note: tmux's -v means VERTICAL layout (panes stacked top-to-bottom, new pane BELOW)
    // tmux's -h means HORIZONTAL layout (panes side-by-side, new pane to the RIGHT)
    // This is opposite to what you might intuitively expect!
    return {
      type: 'split',
      direction: flag === '-h' ? 'vertical' : 'horizontal',
    };
  }

  // Navigation command: select-pane -L/-R/-U/-D or selectp -L/-R/-U/-D
  const navMatch = trimmed.match(/^(select-pane|selectp)\s+-([LRUD])/i);
  if (navMatch) {
    return {
      type: 'navigate',
      direction: navMatch[2].toUpperCase() as 'L' | 'R' | 'U' | 'D',
    };
  }

  // Swap command: swap-pane -s %X -t %Y or swapp -s %X -t %Y
  const swapMatch = trimmed.match(/^(swap-pane|swapp)\s+.*-s\s+(%\d+)\s+.*-t\s+(%\d+)/);
  if (swapMatch) {
    return {
      type: 'swap',
      sourcePaneId: swapMatch[2],
      targetPaneId: swapMatch[3],
    };
  }

  // Also match reversed order: -t first, then -s
  const swapMatchReverse = trimmed.match(/^(swap-pane|swapp)\s+.*-t\s+(%\d+)\s+.*-s\s+(%\d+)/);
  if (swapMatchReverse) {
    return {
      type: 'swap',
      sourcePaneId: swapMatchReverse[3],
      targetPaneId: swapMatchReverse[2],
    };
  }

  // Select pane by ID: select-pane -t %X or selectp -t %X
  const selectMatch = trimmed.match(/^(select-pane|selectp)\s+-t\s+(%\d+)/);
  if (selectMatch) {
    return {
      type: 'select-pane',
      paneId: selectMatch[2],
    };
  }

  return null;
}

/**
 * Check if a command is one we can apply optimistic updates to.
 */
export function isOptimisticCommand(command: string): boolean {
  const parsed = parseCommand(command);
  return parsed !== null;
}
