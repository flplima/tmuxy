/**
 * commandUi state — parallel state for command mode and status messages.
 *
 * Owns context fields: commandMode, statusMessage, statusLine, prefixActive.
 * Action implementations live in ../actions/commandUi.ts.
 */

export const commandUiState = {
  on: {
    PREFIX_MODE_CHANGE: { actions: 'commandUi_setPrefixActive' },
    COMMAND_MODE_SUBMIT: { actions: 'commandUi_submitCommandMode' },
    COMMAND_MODE_CANCEL: { actions: 'commandUi_cancelCommandMode' },
    SHOW_STATUS_MESSAGE: { actions: 'commandUi_showStatusMessage' },
    CLEAR_STATUS_MESSAGE: { actions: 'commandUi_clearStatusMessage' },
  },
} as const;
