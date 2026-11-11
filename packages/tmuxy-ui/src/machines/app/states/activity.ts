/** activity state: the inbox of every pane that said something (docs/ACTIVITY.md). */

export const activityState = {
  on: {
    TOGGLE_ACTIVITY: { actions: 'activity_toggle' },
    REFRESH_ACTIVITY: { actions: 'activity_refresh' },
    ACTIVITY_LOADED: { actions: 'activity_loaded' },
    ACTIVITY_GO: { actions: 'activity_go' },
    ACTIVITY_GO_MOST_URGENT: { actions: 'activity_goMostUrgent' },
  },
} as const;
