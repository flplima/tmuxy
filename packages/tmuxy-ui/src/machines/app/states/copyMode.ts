/**
 * copyMode state — parallel state for client-side copy mode.
 *
 * Owns context field: copyModeStates.
 *
 * Spread into states.idle.on (not the machine root) — copy mode events
 * only fire when connected and idle, never during connecting.
 *
 * Action implementations live in ../actions/copyMode.ts (with the shared
 * copyModeExitTimes Map and COPY_MODE_REENTRY_COOLDOWN constant).
 */

export const copyModeState = {
  on: {
    ENTER_COPY_MODE: { actions: 'copyMode_enter' },
    EXIT_COPY_MODE: { actions: 'copyMode_exit' },
    COPY_MODE_CHUNK_LOADED: { actions: 'copyMode_chunkLoaded' },
    COPY_MODE_CURSOR_MOVE: { actions: 'copyMode_cursorMove' },
    COPY_MODE_SELECTION_START: { actions: 'copyMode_selectionStart' },
    COPY_MODE_SELECTION_CLEAR: { actions: 'copyMode_selectionClear' },
    COPY_MODE_WORD_SELECT: { actions: 'copyMode_wordSelect' },
    COPY_MODE_LINE_SELECT: { actions: 'copyMode_lineSelect' },
    COPY_MODE_SCROLL: { actions: 'copyMode_scroll' },
    COPY_MODE_YANK: { actions: 'copyMode_yank' },
    COPY_MODE_KEY: { actions: 'copyMode_key' },
  },
} as const;

