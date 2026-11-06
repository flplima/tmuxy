/**
 * viewport state — the cell, the container and the size this client asks
 * tmux for. Spread into the machine root: the size actor measures before the
 * first connection and through every reconnect.
 */

export const viewportGlobalEvents = {
  SET_CHAR_SIZE: { actions: 'viewport_setCharSize' },
  REFIT_GRID: { actions: 'viewport_refitGrid' },
  SET_PHONE_LAYOUT: { actions: 'viewport_setPhoneLayout' },
  SET_TARGET_SIZE: { actions: 'viewport_setTargetSize' },
  SET_CONTAINER_SIZE: { actions: 'viewport_setContainerSize' },
  SET_BODY_SIZE: { actions: 'viewport_setBodySize' },
  OBSERVE_CONTAINER: { actions: 'viewport_observeContainer' },
} as const;
