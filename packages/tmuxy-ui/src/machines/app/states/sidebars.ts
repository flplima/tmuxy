/**
 * sidebars state — the `on` slice for the two sidebar columns (tree + dock).
 */

export const sidebarsGlobalEvents = {
  SYNC_DOCK_SIZE: { actions: 'sidebars_syncDockSize' },
  TOGGLE_SIDEBAR: { actions: 'sidebars_toggle' },
  TOGGLE_TAB_COLLAPSE: { actions: 'sidebars_toggleTabCollapse' },
  START_SIDEBAR: { actions: 'sidebars_start' },
  SIDEBAR_START_TIMEOUT: { actions: 'sidebars_sidebarStartTimeout' },
  SIDEBAR_RESIZE_PREVIEW: { actions: 'sidebars_sidebarResizePreview' },
  SIDEBAR_RESIZE_COMMIT: { actions: 'sidebars_sidebarResizeCommit' },
  SIDEBAR_PREVIEW_EXPIRE: { actions: 'sidebars_sidebarPreviewExpire' },
  PEEK_SIDEBAR: { actions: 'sidebars_peekSidebar' },
  END_SIDEBAR_PEEK: { actions: 'sidebars_endSidebarPeek' },
} as const;

export const sidebarsIdleEvents = {
  FOCUS_SIDEBAR: { actions: 'sidebars_focus' },
  BLUR_SIDEBAR: { actions: 'sidebars_blur' },
} as const;
