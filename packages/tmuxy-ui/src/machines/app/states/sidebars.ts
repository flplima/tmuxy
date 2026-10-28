/**
 * sidebars state — the `on` slice for the two sidebar columns (tree + dock).
 *
 * Owns context fields: leftSidebarOpen, leftSidebarFocused, rightSidebarOpen,
 * rightSidebarFocused, leftSidebarStartFailed, rightSidebarStartFailed,
 * leftSidebarStarting, rightSidebarStarting, sidebarColsPreview, dockRowsSent,
 * collapsedTabIds.
 */

export const sidebarsGlobalEvents = {
  SYNC_DOCK_ROWS: { actions: 'sidebars_syncDockRows' },
  TOGGLE_LEFT_SIDEBAR: {
    actions: 'sidebars_toggleLeftSidebar',
  },
  TOGGLE_TAB_COLLAPSE: { actions: 'sidebars_toggleTabCollapse' },
  START_RIGHT_SIDEBAR: { actions: 'sidebars_startRightSidebar' },
  SIDEBAR_START_TIMEOUT: { actions: 'sidebars_sidebarStartTimeout' },
  SIDEBAR_RESIZE_PREVIEW: {
    actions: 'sidebars_sidebarResizePreview',
  },
  SIDEBAR_RESIZE_COMMIT: {
    actions: 'sidebars_sidebarResizeCommit',
  },
  SIDEBAR_PREVIEW_EXPIRE: { actions: 'sidebars_sidebarPreviewExpire' },
} as const;

export const sidebarsIdleEvents = {
  FOCUS_LEFT_SIDEBAR: { actions: 'sidebars_focusLeftSidebar' },
  BLUR_LEFT_SIDEBAR: { actions: 'sidebars_blurLeftSidebar' },
  TOGGLE_RIGHT_SIDEBAR: {
    actions: 'sidebars_toggleRightSidebar',
  },
  FOCUS_RIGHT_SIDEBAR: { actions: 'sidebars_focusRightSidebar' },
  BLUR_RIGHT_SIDEBAR: { actions: 'sidebars_blurRightSidebar' },
} as const;
