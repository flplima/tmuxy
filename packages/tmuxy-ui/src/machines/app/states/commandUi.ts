/**
 * commandUi state — a root-level `on` slice for command mode and status messages.
 *
 * Owns context fields: commandMode, statusMessage, prefixActive, keyTable,
 * keysViewOpen, renamingPaneId.
 * Action implementations live in ../actions/commandUi.ts.
 */

export const commandUiState = {
  on: {
    RENAME_PANE: { actions: 'commandUi_renamePane' },
    PANE_RENAME_END: { actions: 'commandUi_paneRenameEnd' },
    PREFIX_MODE_CHANGE: { actions: 'commandUi_setPrefixActive' },
    KEY_TABLE_CHANGE: { actions: 'commandUi_setKeyTable' },
    TOGGLE_KEYS_VIEW: { actions: 'commandUi_toggleKeysView' },
    OPEN_COMMAND_PROMPT: { actions: 'commandUi_openCommandPrompt' },
    COMMAND_MODE_SUBMIT: { actions: 'commandUi_submitCommandMode' },
    COMMAND_MODE_CANCEL: { actions: 'commandUi_cancelCommandMode' },
    SHOW_STATUS_MESSAGE: { actions: 'commandUi_showStatusMessage' },
    CLEAR_STATUS_MESSAGE: { actions: 'commandUi_clearStatusMessage' },
  },
} as const;
