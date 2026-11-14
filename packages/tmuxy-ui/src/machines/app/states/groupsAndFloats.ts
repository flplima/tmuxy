export const groupsAndFloatsGlobalEvents = {
  OPEN_CONNECT_FLOAT: {
    actions: 'groupsAndFloats_openConnectFloat',
  },
} as const;

export const groupsAndFloatsIdleEvents = {
  CLOSE_FLOAT: { actions: 'groupsAndFloats_closeFloat' },
  MINIMIZE_FLOAT: { actions: 'groupsAndFloats_minimizeFloat' },
} as const;
