export const commandUiState = {
  on: {
    RENAME_PANE: { actions: 'commandUi_renamePane' },
    RENAME_PANE_COMMIT: { actions: 'commandUi_renamePaneCommit' },
    PREFIX_MODE_CHANGE: { actions: 'commandUi_setPrefixActive' },
    KEY_TABLE_CHANGE: { actions: 'commandUi_setKeyTable' },
    TOGGLE_KEYS_VIEW: { actions: 'commandUi_toggleKeysView' },
    REQUEST_CLOSE_CONFIRM: { actions: 'commandUi_holdClose' },
    CANCEL_CLOSE: { actions: 'commandUi_dropPendingClose' },
    OPEN_COMMAND_PROMPT: { actions: 'commandUi_openCommandPrompt' },
    COMMAND_MODE_SUBMIT: { actions: 'commandUi_submitCommandMode' },
    COMMAND_MODE_CANCEL: { actions: 'commandUi_cancelCommandMode' },
    SHOW_STATUS_MESSAGE: { actions: 'commandUi_showStatusMessage' },
    CLEAR_STATUS_MESSAGE: { actions: 'commandUi_clearStatusMessage' },
  },
} as const;
