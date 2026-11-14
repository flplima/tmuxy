/** copyMode state — client-side copy mode (docs/COPY-MODE.md). */

export const copyModeState = {
  on: {
    COPY_SELECTION: { actions: 'copyMode_copySelection' },
    ENTER_COPY_MODE: { actions: 'copyMode_enter' },
    EXIT_COPY_MODE: { actions: 'copyMode_exit' },
    ENTER_SCROLL_MODE: { actions: 'copyMode_enterScroll' },
    EXIT_SCROLL_MODE: { actions: 'copyMode_exitScroll' },
    SELECT_ALL_SCROLLBACK: { actions: 'copyMode_selectAll' },
    COPY_MODE_CHUNK_LOADED: { actions: 'copyMode_chunkLoaded' },
    COPY_MODE_CHUNK_FAILED: { actions: 'copyMode_chunkFailed' },
    COPY_MODE_CURSOR_MOVE: { actions: 'copyMode_cursorMove' },
    COPY_MODE_SELECTION_START: { actions: 'copyMode_selectionStart' },
    COPY_MODE_SELECTION_CLEAR: { actions: 'copyMode_selectionClear' },
    COPY_MODE_WORD_SELECT: { actions: 'copyMode_wordSelect' },
    COPY_MODE_LINE_SELECT: { actions: 'copyMode_lineSelect' },
    COPY_MODE_SCROLL: { actions: 'copyMode_scroll' },
    COPY_MODE_YANK: { actions: 'copyMode_yank' },
    COPY_MODE_MOUSE_COPY: { actions: 'copyMode_mouseCopy' },
    COPY_MODE_COPIED_EXIT: { actions: 'copyMode_copiedExit' },
    COPY_MODE_KEY: { actions: 'copyMode_key' },
    PROMPT_JUMP: { actions: 'promptMarks_jump' },
    PROMPT_MARKS_LOADED: { actions: 'promptMarks_loaded' },
    COPY_LAST_OUTPUT: { actions: 'promptMarks_copyLastOutput' },
  },
} as const;
