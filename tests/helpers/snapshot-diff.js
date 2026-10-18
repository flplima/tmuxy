/**
 * Snapshot Diff — Comparison of extracted UI state against tmux state.
 *
 * Extracted from snapshot-compare.js to keep helper modules concise.
 */

/**
 * Compare UI snapshot against tmux snapshot.
 *
 * Returns { pass, checks[] } where each check is { name, pass, details? }.
 * No tolerances — any mismatch is reported as a real bug.
 *
 * @param {Object} ui - Result from extractUIState()
 * @param {Object} tmux - Result from extractTmuxState()
 * @returns {{pass: boolean, checks: Array<{name: string, pass: boolean, details?: string}>}}
 */
function compareSnapshots(ui, tmux) {
  const checks = [];

  function check(name, pass, details) {
    checks.push({ name, pass, ...(details ? { details } : {}) });
  }

  // 1. Window count
  check(
    'Window count',
    ui.windows.length === tmux.windows.length,
    ui.windows.length !== tmux.windows.length
      ? `UI: ${ui.windows.length}, tmux: ${tmux.windows.length}`
      : undefined,
  );

  // 2. Window names (by index)
  if (ui.windows.length === tmux.windows.length) {
    const nameErrors = [];
    for (let i = 0; i < ui.windows.length; i++) {
      const uw = ui.windows[i];
      const tw = tmux.windows[i];
      if (uw.name !== tw.name) {
        nameErrors.push(`index ${i}: UI="${uw.name}", tmux="${tw.name}"`);
      }
    }
    check(
      'Window names',
      nameErrors.length === 0,
      nameErrors.length > 0 ? nameErrors.join('; ') : undefined,
    );
  } else {
    check('Window names', false, 'Skipped (count mismatch)');
  }

  // 3. Active window ID
  check(
    'Active window ID',
    ui.meta.activeWindowId === tmux.meta.activeWindowId,
    ui.meta.activeWindowId !== tmux.meta.activeWindowId
      ? `UI: ${ui.meta.activeWindowId}, tmux: ${tmux.meta.activeWindowId}`
      : undefined,
  );

  // 4. Pane count
  check(
    'Pane count',
    ui.panes.length === tmux.panes.length,
    ui.panes.length !== tmux.panes.length
      ? `UI: ${ui.panes.length}, tmux: ${tmux.panes.length}`
      : undefined,
  );

  // 5. Pane IDs match
  const uiPaneIds = ui.panes.map((p) => p.tmuxId).sort();
  const tmuxPaneIds = tmux.panes.map((p) => p.tmuxId).sort();
  check(
    'Pane IDs',
    uiPaneIds.join(',') === tmuxPaneIds.join(','),
    uiPaneIds.join(',') !== tmuxPaneIds.join(',')
      ? `UI: [${uiPaneIds}], tmux: [${tmuxPaneIds}]`
      : undefined,
  );

  // Only compare per-pane properties if IDs match
  const idsMatch = uiPaneIds.join(',') === tmuxPaneIds.join(',');

  // 6. Pane positions (x, y)
  if (idsMatch) {
    const posErrors = [];
    for (const uiPane of ui.panes) {
      const tmuxPane = tmux.panes.find((p) => p.tmuxId === uiPane.tmuxId);
      if (!tmuxPane) continue;
      if (uiPane.x !== tmuxPane.x || uiPane.y !== tmuxPane.y) {
        posErrors.push(
          `${uiPane.tmuxId}: UI=(${uiPane.x},${uiPane.y}), tmux=(${tmuxPane.x},${tmuxPane.y})`,
        );
      }
    }
    check(
      'Pane positions',
      posErrors.length === 0,
      posErrors.length > 0 ? posErrors.join('; ') : undefined,
    );
  } else {
    check('Pane positions', false, 'Skipped (ID mismatch)');
  }

  // 7. Pane dimensions (width, height)
  if (idsMatch) {
    const dimErrors = [];
    for (const uiPane of ui.panes) {
      const tmuxPane = tmux.panes.find((p) => p.tmuxId === uiPane.tmuxId);
      if (!tmuxPane) continue;
      if (uiPane.width !== tmuxPane.width || uiPane.height !== tmuxPane.height) {
        dimErrors.push(
          `${uiPane.tmuxId}: UI=${uiPane.width}x${uiPane.height}, tmux=${tmuxPane.width}x${tmuxPane.height}`,
        );
      }
    }
    check(
      'Pane dimensions',
      dimErrors.length === 0,
      dimErrors.length > 0 ? dimErrors.join('; ') : undefined,
    );
  } else {
    check('Pane dimensions', false, 'Skipped (ID mismatch)');
  }

  // 8. Active pane ID
  check(
    'Active pane ID',
    ui.meta.activePaneId === tmux.meta.activePaneId,
    ui.meta.activePaneId !== tmux.meta.activePaneId
      ? `UI: ${ui.meta.activePaneId}, tmux: ${tmux.meta.activePaneId}`
      : undefined,
  );

  // 9. Pane content (per pane)
  // Check if any pane has content at all — if the content pipeline hasn't
  // delivered data yet (e.g., fresh CI page), content/cursor checks pass
  // with a warning since we can't meaningfully compare.
  const anyUiContent = Object.values(ui.paneContent).some((lines) =>
    lines.some((l) => (l || '').trim().length > 0),
  );
  if (idsMatch) {
    if (!anyUiContent) {
      check('Pane content', true, 'Skipped (no UI content yet — content pipeline delay)');
    } else {
      const contentErrors = [];
      for (const uiPane of ui.panes) {
        // Compare non-empty content lines only, ignoring vertical position.
        // The UI's vt100 emulator may retain prior redraws (e.g. a bash
        // prompt that repainted itself once its async git-status hook
        // returned) that tmux's `capture-pane -p` no longer shows. Treat
        // tmux's lines as the required floor: every line tmux thinks is
        // visible must also appear in the UI, IN ORDER. Extra leading
        // lines in the UI are tolerated.
        const getNonEmpty = (lines) => {
          const seen = new Set();
          return (lines || [])
            .map((l) => (l || '').replace(/\s+$/, ''))
            .filter((l) => {
              if (l === '' || seen.has(l)) return false;
              seen.add(l);
              return true;
            });
        };
        const uiNonEmpty = getNonEmpty(ui.paneContent[uiPane.tmuxId]);
        const tmuxNonEmpty = getNonEmpty(tmux.paneContent[uiPane.tmuxId]);

        // Walk tmux's lines, advancing through UI's lines and looking for
        // each one in order. A missing tmux line is a real content
        // divergence; unmatched UI lines (extra redraws / scrollback) are OK.
        let uiIdx = 0;
        const missing = [];
        for (const tline of tmuxNonEmpty) {
          let found = false;
          while (uiIdx < uiNonEmpty.length) {
            if (uiNonEmpty[uiIdx] === tline) {
              found = true;
              uiIdx++;
              break;
            }
            uiIdx++;
          }
          if (!found) missing.push(tline);
        }

        if (missing.length > 0) {
          contentErrors.push(
            `${uiPane.tmuxId}: tmux lines not found in UI (in order)\n` +
              `      missing: ${JSON.stringify(missing)}\n` +
              `      UI:      ${JSON.stringify(uiNonEmpty)}\n` +
              `      tmux:    ${JSON.stringify(tmuxNonEmpty)}`,
          );
        }
      }
      check(
        'Pane content',
        contentErrors.length === 0,
        contentErrors.length > 0 ? contentErrors.join('\n    ') : undefined,
      );
    }
  } else {
    check('Pane content', false, 'Skipped (ID mismatch)');
  }

  // 10. Cursor position (X, Y)
  // Skip when no UI content has arrived (content pipeline delay).
  if (idsMatch) {
    if (!anyUiContent) {
      check('Cursor positions', true, 'Skipped (no UI content yet — content pipeline delay)');
    } else {
      const cursorErrors = [];
      for (const uiPane of ui.panes) {
        const tmuxPane = tmux.panes.find((p) => p.tmuxId === uiPane.tmuxId);
        if (!tmuxPane) continue;
        if (uiPane.cursorX !== tmuxPane.cursorX || uiPane.cursorY !== tmuxPane.cursorY) {
          cursorErrors.push(
            `${uiPane.tmuxId}: UI=(${uiPane.cursorX},${uiPane.cursorY}), tmux=(${tmuxPane.cursorX},${tmuxPane.cursorY})`,
          );
        }
      }
      check(
        'Cursor positions',
        cursorErrors.length === 0,
        cursorErrors.length > 0 ? cursorErrors.join('; ') : undefined,
      );
    }
  } else {
    check('Cursor positions', false, 'Skipped (ID mismatch)');
  }

  // 11. Pane commands (used instead of pane titles because tmux's #{pane_title}
  // is not updated by OSC title sequences in control mode, while the server
  // parses OSC sequences directly — making title comparison unreliable.
  // pane_current_command is reliably synced between both sides.)
  if (idsMatch) {
    const cmdErrors = [];
    for (const uiPane of ui.panes) {
      const tmuxPane = tmux.panes.find((p) => p.tmuxId === uiPane.tmuxId);
      if (!tmuxPane) continue;
      if (uiPane.command !== tmuxPane.command) {
        cmdErrors.push(
          `${uiPane.tmuxId}: UI=${JSON.stringify(uiPane.command)}, tmux=${JSON.stringify(tmuxPane.command)}`,
        );
      }
    }
    check(
      'Pane commands',
      cmdErrors.length === 0,
      cmdErrors.length > 0 ? cmdErrors.join('; ') : undefined,
    );
  } else {
    check('Pane commands', false, 'Skipped (ID mismatch)');
  }

  // 12. Group membership (same pane sets)
  const uiGroupSets = Object.values(ui.paneGroups).map((g) => [...g.paneIds].sort().join(','));
  const tmuxGroupSets = Object.values(tmux.paneGroups).map((g) => [...g.paneIds].sort().join(','));
  uiGroupSets.sort();
  tmuxGroupSets.sort();
  check(
    'Group membership',
    uiGroupSets.join('|') === tmuxGroupSets.join('|'),
    uiGroupSets.join('|') !== tmuxGroupSets.join('|')
      ? `UI groups: [${uiGroupSets.join('], [')}], tmux groups: [${tmuxGroupSets.join('], [')}]`
      : undefined,
  );

  // 13. Group active tab
  // Match groups by pane set since IDs may differ between UI and tmux
  const uiGroupsBySet = {};
  for (const [id, group] of Object.entries(ui.paneGroups)) {
    const key = [...group.paneIds].sort().join(',');
    uiGroupsBySet[key] = { id, activeTab: ui.groupActiveTabs[id] };
  }
  const tmuxGroupsBySet = {};
  for (const [id, group] of Object.entries(tmux.paneGroups)) {
    const key = [...group.paneIds].sort().join(',');
    tmuxGroupsBySet[key] = { id, activeTab: tmux.groupActiveTabs[id] };
  }
  const activeTabErrors = [];
  for (const [setKey, uiGroup] of Object.entries(uiGroupsBySet)) {
    const tmuxGroup = tmuxGroupsBySet[setKey];
    if (tmuxGroup && uiGroup.activeTab !== tmuxGroup.activeTab) {
      activeTabErrors.push(
        `Group [${setKey}]: UI active=${uiGroup.activeTab}, tmux active=${tmuxGroup.activeTab}`,
      );
    }
  }
  check(
    'Group active tab',
    activeTabErrors.length === 0,
    activeTabErrors.length > 0 ? activeTabErrors.join('; ') : undefined,
  );

  // 14. Group tab names vs pane commands
  // Compare the command reported by tmux for each grouped pane against the UI's pane command
  const tabNameErrors = [];
  for (const uiPane of ui.panes) {
    // Check if this pane is in any group
    const inGroup = Object.values(ui.paneGroups).some((g) => g.paneIds.includes(uiPane.tmuxId));
    if (!inGroup) continue;
    const tmuxCommand = tmux.groupTabNames[uiPane.tmuxId];
    if (tmuxCommand !== undefined && uiPane.command !== tmuxCommand) {
      tabNameErrors.push(`${uiPane.tmuxId}: UI="${uiPane.command}", tmux="${tmuxCommand}"`);
    }
  }
  check(
    'Group tab names',
    tabNameErrors.length === 0,
    tabNameErrors.length > 0 ? tabNameErrors.join('; ') : undefined,
  );

  // 15. Float pane existence
  check(
    'Float panes',
    ui.floatPaneIds.join(',') === tmux.floatPaneIds.join(','),
    ui.floatPaneIds.join(',') !== tmux.floatPaneIds.join(',')
      ? `UI: [${ui.floatPaneIds}], tmux: [${tmux.floatPaneIds}]`
      : undefined,
  );

  return {
    pass: checks.every((c) => c.pass),
    checks,
  };
}

module.exports = { compareSnapshots };
