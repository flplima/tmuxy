/**
 * Pane Group State Management
 *
 * Groups are derived entirely from window names.
 * Window naming: __group_{paneNum1}-{paneNum2}-{paneNum3}
 * Example: __group_4-6-7 means a group containing panes %4, %6, %7
 *
 * No env var, no UUID. The pane list in the name IS the group identity.
 */

/**
 * Parse a group window name to extract pane IDs.
 * Format: __group_{paneNum1}-{paneNum2}-{paneNum3}
 * Returns null if the name doesn't match.
 */
export function parseGroupWindowName(name: string): {
  paneIds: string[];
} | null {
  if (!name.startsWith('__group_')) return null;
  const rest = name.slice(8); // Skip "__group_"
  if (!rest) return null;

  // New format: only digits and dashes
  if (/^[\d-]+$/.test(rest)) {
    const paneIds = rest
      .split('-')
      .filter((s) => s.length > 0)
      .map((s) => `%${s}`);
    if (paneIds.length >= 2) {
      return { paneIds };
    }
    return null;
  }

  // Old format: __group_{uuid}_{n} — parse to get groupId for backwards compat
  // but we can still extract info: it's a group window
  const match = rest.match(/^([a-z0-9_]+)_(\d+)$/);
  if (match) {
    // Old format detected — return null for paneIds (handled via env in legacy path)
    // The caller should use paneGroupPaneIds from the server if available
    return null;
  }

  return null;
}

/**
 * Check if a window name is a group window
 */
export function isGroupWindow(name: string): boolean {
  return name.startsWith('__group_');
}
