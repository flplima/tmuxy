/**
 * Panes currently running their leave (kill) animation, keyed by tmux pane
 * id. The model has already dropped these panes, but PaneLayout keeps them
 * mounted for the duration of the exit morph — this context lets `usePane`
 * fall back to the frozen snapshot so the dying pane's content stays
 * rendered without threading props through Pane/TerminalPane/PaneHeader.
 *
 * Lives in its own module (not AppContext) to avoid an import cycle:
 * PaneLayout provides the value, AppContext's usePane consumes it.
 */

import { createContext } from 'react';
import type { TmuxPane } from './types';

export const LeavingPanesContext = createContext<ReadonlyMap<string, TmuxPane>>(new Map());
