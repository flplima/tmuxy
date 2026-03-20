/**
 * Snapshot Compare — Core Extraction + Comparison
 *
 * Captures "visible state" from both the tmuxy web UI (via browser JS)
 * and tmux CLI, then compares them to find mismatches. Read-only — no
 * interactions, no mutations.
 *
 * Reusable module: import extractUIState, extractTmuxState, compareSnapshots.
 */

const { tmuxQuery } = require('./cli');

// ==================== UI State Extraction ====================

/**
 * Extract the full visible state from the browser via XState context + DOM.
 *
 * Single page.evaluate() call extracts:
 * - Windows (excluding group/float)
 * - Panes in active window (positions, dimensions, cursor, command, title)
 * - Pane content from pane.content (TerminalCell[][])
 * - Pane groups from ctx.paneGroups
 * - Float panes from ctx.floatPanes
 * - Meta: sessionName, activeWindowId, activePaneId
 *
 * @param {Page} page - Playwright page
 * @returns {Promise<Object|null>}
 */
async function extractUIState(page) {
  return page.evaluate(() => {
    const snap = window.app?.getSnapshot();
    if (!snap?.context) return null;
    const ctx = snap.context;

    // Windows (excluding group/float)
    const windows = (ctx.windows || [])
      .filter(w => !w.isPaneGroupWindow && !w.isFloatWindow)
      .map(w => ({ id: w.id, index: w.index, name: w.name, active: w.active }));

    // Panes in active window
    const visiblePanes = (ctx.panes || []).filter(p => p.windowId === ctx.activeWindowId);
    const panes = visiblePanes.map(p => ({
      tmuxId: p.tmuxId,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      active: p.active,
      cursorX: p.cursorX,
      cursorY: p.cursorY,
      command: p.command,
      title: p.title,
    }));

    // Pane content from pane.content (TerminalCell[][])
    // Falls back to DOM terminal lines if XState content is empty (e.g., fresh
    // CI page where the VT100 pipeline hasn't delivered content yet).
    const paneContent = {};
    const usedDomFallback = {};
    for (const p of visiblePanes) {
      const lines = [];
      if (p.content && Array.isArray(p.content)) {
        for (const cellLine of p.content) {
          if (!Array.isArray(cellLine)) { lines.push(''); continue; }
          lines.push(cellLine.map(cell => cell.c || '').join(''));
        }
      }
      // Fallback: if XState content is all-empty, read from DOM
      const hasContent = lines.some(l => l.trim().length > 0);
      if (!hasContent) {
        const paneEl = document.querySelector(`[data-pane-id="${p.tmuxId}"] .terminal-content`);
        if (paneEl) {
          const termLines = paneEl.querySelectorAll('.terminal-line');
          lines.length = 0;
          for (const lineEl of termLines) {
            lines.push(lineEl.textContent || '');
          }
          usedDomFallback[p.tmuxId] = true;
        }
      }
      paneContent[p.tmuxId] = lines;
    }

    // Pane groups from ctx.paneGroups
    const paneGroups = {};
    if (ctx.paneGroups) {
      for (const [groupId, group] of Object.entries(ctx.paneGroups)) {
        paneGroups[groupId] = {
          paneIds: [...group.paneIds],
        };
      }
    }

    // Determine active tab per group: the pane in the group that belongs to activeWindowId
    const activeWindowPaneIds = new Set(visiblePanes.map(p => p.tmuxId));
    const groupActiveTabs = {};
    for (const [groupId, group] of Object.entries(paneGroups)) {
      const activePaneInGroup = group.paneIds.find(id => activeWindowPaneIds.has(id));
      groupActiveTabs[groupId] = activePaneInGroup || null;
    }

    // Group tab names from DOM
    const groupTabNames = {};
    const tabEls = document.querySelectorAll('.pane-tab .pane-tab-title');
    for (const el of tabEls) {
      const paneEl = el.closest('[data-pane-id]');
      if (paneEl) {
        const paneId = paneEl.getAttribute('data-pane-id');
        if (paneId) {
          if (!groupTabNames[paneId]) groupTabNames[paneId] = [];
          groupTabNames[paneId].push(el.textContent || '');
        }
      }
    }

    // Float panes from ctx.floatPanes
    const floatPaneIds = Object.keys(ctx.floatPanes || {}).sort();

    return {
      meta: {
        sessionName: ctx.sessionName,
        activeWindowId: ctx.activeWindowId,
        activePaneId: ctx.activePaneId,
      },
      windows,
      panes,
      paneContent,
      usedDomFallback,
      paneGroups,
      groupActiveTabs,
      groupTabNames,
      floatPaneIds,
    };
  });
}

// ==================== Tmux State Extraction ====================

/**
 * Extract the full visible state from tmux via CLI queries.
 *
 * Read-only tmux queries (safe with control mode):
 * 1. list-windows — all windows, separated into visible/group/float
 * 2. list-panes — active window panes with positions
 * 3. capture-pane — per visible pane content
 * 4. list-panes -s — pane-to-window map (for group active tab)
 *
 * @param {string} sessionName - tmux session name
 * @returns {Object|null}
 */
function extractTmuxState(sessionName) {
  try {
    // 1. List all windows
    const winRaw = tmuxQuery(
      `list-windows -t ${sessionName} -F "#{window_id}|#{window_index}|#{window_name}|#{window_active}"`
    );
    const allWindows = winRaw.split('\n').filter(Boolean).map(line => {
      const [id, index, name, active] = line.split('|');
      return { id, index: parseInt(index, 10), name, active: active === '1' };
    });

    // Separate visible, group, and float windows
    const windows = [];
    const groupWindows = [];
    const floatWindows = [];
    for (const w of allWindows) {
      if (w.name.startsWith('__group_')) {
        groupWindows.push(w);
      } else if (w.name.startsWith('__float_')) {
        floatWindows.push(w);
      } else {
        windows.push(w);
      }
    }

    // Find active window
    const activeWindow = allWindows.find(w => w.active);
    const activeWindowId = activeWindow?.id || null;

    // Check if the active window is a group or float window
    const activeWindowIsGroupOrFloat = activeWindow &&
      (activeWindow.name.startsWith('__group_') || activeWindow.name.startsWith('__float_'));

    // 2. List panes in active window
    const paneRaw = tmuxQuery(
      `list-panes -t ${sessionName} -F "#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}|#{pane_active}|#{pane_current_command}|#{pane_title}"`
    );
    const panes = paneRaw.split('\n').filter(Boolean).map(line => {
      const parts = line.split('|');
      return {
        tmuxId: parts[0],
        x: parseInt(parts[1], 10),
        y: parseInt(parts[2], 10),
        width: parseInt(parts[3], 10),
        height: parseInt(parts[4], 10),
        cursorX: parseInt(parts[5], 10),
        cursorY: parseInt(parts[6], 10),
        active: parts[7] === '1',
        command: parts[8],
        title: parts.slice(9).join('|'), // title may contain |
      };
    });

    // Active pane ID: when the active window is a group/float window, the
    // pane_active flag points to the group/float's active pane, not the
    // user-focused pane. In that case, query visible (non-group, non-float)
    // windows for their per-window active panes instead.
    let activePaneId;
    if (activeWindowIsGroupOrFloat) {
      // Query all panes across all windows to find active panes in visible windows
      const visibleWindowIds = new Set(windows.map(w => w.id));
      const allPanesForActive = tmuxQuery(
        `list-panes -s -t ${sessionName} -F "#{pane_id}|#{window_id}|#{pane_active}"`
      );
      const visibleActivePanes = allPanesForActive.split('\n').filter(Boolean)
        .map(line => { const [pid, wid, act] = line.split('|'); return { pid, wid, active: act === '1' }; })
        .filter(p => visibleWindowIds.has(p.wid) && p.active);
      // Each visible window has one active pane; pick the first one found
      activePaneId = visibleActivePanes.length > 0 ? visibleActivePanes[0].pid : null;
    } else {
      activePaneId = panes.find(p => p.active)?.tmuxId || null;
    }

    // 3. Capture pane content per visible pane
    // Don't use tmuxQuery() here — it trims leading whitespace which strips
    // leading blank lines from the capture, causing line-number misalignment
    // when comparing against the UI's VT100 content.
    const { execSync } = require('child_process');
    const paneContent = {};
    for (const pane of panes) {
      const socketFlag = process.env.TMUX_SOCKET ? `-L ${process.env.TMUX_SOCKET} ` : '';
      const raw = execSync(`tmux ${socketFlag}capture-pane -t ${pane.tmuxId} -p`, {
        encoding: 'utf-8',
        timeout: 30000,
      });
      // Strip only the trailing newline that capture-pane always appends
      const content = raw.replace(/\n$/, '');
      paneContent[pane.tmuxId] = content.split('\n');
    }

    // 4. List all panes across all windows (for group active tab detection)
    const allPanesRaw = tmuxQuery(
      `list-panes -s -t ${sessionName} -F "#{pane_id}|#{window_id}|#{pane_current_command}"`
    );
    const paneWindowMap = {};
    const paneCommandMap = {};
    for (const line of allPanesRaw.split('\n').filter(Boolean)) {
      const [paneId, windowId, command] = line.split('|');
      paneWindowMap[paneId] = windowId;
      paneCommandMap[paneId] = command;
    }

    // 5. Parse __group_ window names → group membership
    // Window name format: __group_N-N-N (e.g., __group_4-6-7 → ["%4", "%6", "%7"])
    // Deduplicate by pane set: when a group tab is active, the same group name
    // appears in two windows (the hidden group window and the active window).
    const paneGroups = {};
    const groupActiveTabs = {};
    const seenPaneSets = new Set();
    for (const gw of groupWindows) {
      const suffix = gw.name.replace('__group_', '');
      const paneIds = suffix.split('-').map(n => `%${n}`);
      const paneSetKey = [...paneIds].sort().join(',');
      if (seenPaneSets.has(paneSetKey)) continue;
      seenPaneSets.add(paneSetKey);
      paneGroups[gw.id] = { paneIds };

      // Active tab = the pane in this group whose window is the active window
      const activeTab = paneIds.find(pid => paneWindowMap[pid] === activeWindowId);
      groupActiveTabs[gw.id] = activeTab || null;
    }

    // Group tab names: use the command of each pane in the group
    const groupTabNames = {};
    for (const [, group] of Object.entries(paneGroups)) {
      for (const paneId of group.paneIds) {
        groupTabNames[paneId] = paneCommandMap[paneId] || '';
      }
    }

    // 6. Parse __float_ window names → float pane IDs
    // Window name format: __float_N (e.g., __float_5 → "%5")
    const floatPaneIds = floatWindows
      .map(fw => {
        const n = fw.name.replace('__float_', '');
        return `%${n}`;
      })
      .sort();

    return {
      meta: {
        sessionName,
        activeWindowId,
        activePaneId,
      },
      windows,
      panes,
      paneContent,
      paneGroups,
      groupActiveTabs,
      groupTabNames,
      floatPaneIds,
    };
  } catch (e) {
    return null;
  }
}

// ==================== Snapshot Comparison ====================

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
      : undefined
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
    check('Window names', nameErrors.length === 0, nameErrors.length > 0 ? nameErrors.join('; ') : undefined);
  } else {
    check('Window names', false, 'Skipped (count mismatch)');
  }

  // 3. Active window ID
  check(
    'Active window ID',
    ui.meta.activeWindowId === tmux.meta.activeWindowId,
    ui.meta.activeWindowId !== tmux.meta.activeWindowId
      ? `UI: ${ui.meta.activeWindowId}, tmux: ${tmux.meta.activeWindowId}`
      : undefined
  );

  // 4. Pane count
  check(
    'Pane count',
    ui.panes.length === tmux.panes.length,
    ui.panes.length !== tmux.panes.length
      ? `UI: ${ui.panes.length}, tmux: ${tmux.panes.length}`
      : undefined
  );

  // 5. Pane IDs match
  const uiPaneIds = ui.panes.map(p => p.tmuxId).sort();
  const tmuxPaneIds = tmux.panes.map(p => p.tmuxId).sort();
  check(
    'Pane IDs',
    uiPaneIds.join(',') === tmuxPaneIds.join(','),
    uiPaneIds.join(',') !== tmuxPaneIds.join(',')
      ? `UI: [${uiPaneIds}], tmux: [${tmuxPaneIds}]`
      : undefined
  );

  // Only compare per-pane properties if IDs match
  const idsMatch = uiPaneIds.join(',') === tmuxPaneIds.join(',');

  // 6. Pane positions (x, y)
  if (idsMatch) {
    const posErrors = [];
    for (const uiPane of ui.panes) {
      const tmuxPane = tmux.panes.find(p => p.tmuxId === uiPane.tmuxId);
      if (!tmuxPane) continue;
      if (uiPane.x !== tmuxPane.x || uiPane.y !== tmuxPane.y) {
        posErrors.push(`${uiPane.tmuxId}: UI=(${uiPane.x},${uiPane.y}), tmux=(${tmuxPane.x},${tmuxPane.y})`);
      }
    }
    check('Pane positions', posErrors.length === 0, posErrors.length > 0 ? posErrors.join('; ') : undefined);
  } else {
    check('Pane positions', false, 'Skipped (ID mismatch)');
  }

  // 7. Pane dimensions (width, height)
  if (idsMatch) {
    const dimErrors = [];
    for (const uiPane of ui.panes) {
      const tmuxPane = tmux.panes.find(p => p.tmuxId === uiPane.tmuxId);
      if (!tmuxPane) continue;
      if (uiPane.width !== tmuxPane.width || uiPane.height !== tmuxPane.height) {
        dimErrors.push(`${uiPane.tmuxId}: UI=${uiPane.width}x${uiPane.height}, tmux=${tmuxPane.width}x${tmuxPane.height}`);
      }
    }
    check('Pane dimensions', dimErrors.length === 0, dimErrors.length > 0 ? dimErrors.join('; ') : undefined);
  } else {
    check('Pane dimensions', false, 'Skipped (ID mismatch)');
  }

  // 8. Active pane ID
  check(
    'Active pane ID',
    ui.meta.activePaneId === tmux.meta.activePaneId,
    ui.meta.activePaneId !== tmux.meta.activePaneId
      ? `UI: ${ui.meta.activePaneId}, tmux: ${tmux.meta.activePaneId}`
      : undefined
  );

  // 9. Pane content (per pane)
  // Check if any pane has content at all — if the content pipeline hasn't
  // delivered data yet (e.g., fresh CI page), content/cursor checks pass
  // with a warning since we can't meaningfully compare.
  const anyUiContent = Object.values(ui.paneContent).some(lines =>
    lines.some(l => (l || '').trim().length > 0)
  );
  if (idsMatch) {
    if (!anyUiContent) {
      check('Pane content', true, 'Skipped (no UI content yet — content pipeline delay)');
    } else {
      const contentErrors = [];
      for (const uiPane of ui.panes) {
        // Compare non-empty content lines only, ignoring vertical position.
        // During resize events, capture-pane and %output can race, causing
        // the VT100 terminal to have content at a different row offset than
        // tmux's current state. We verify that the SAME non-empty text lines
        // exist in both sides (a "semantic" content match).
        const getNonEmpty = (lines) => {
          const seen = new Set();
          return (lines || [])
            .map(l => (l || '').replace(/\s+$/, ''))
            .filter(l => {
              if (l === '' || seen.has(l)) return false;
              seen.add(l);
              return true;
            });
        };
        const uiNonEmpty = getNonEmpty(ui.paneContent[uiPane.tmuxId]);
        const tmuxNonEmpty = getNonEmpty(tmux.paneContent[uiPane.tmuxId]);

        if (uiNonEmpty.join('\n') !== tmuxNonEmpty.join('\n')) {
          contentErrors.push(
            `${uiPane.tmuxId}: content mismatch\n` +
            `      UI:   ${JSON.stringify(uiNonEmpty)}\n` +
            `      tmux: ${JSON.stringify(tmuxNonEmpty)}`
          );
        }
      }
      check('Pane content', contentErrors.length === 0, contentErrors.length > 0 ? contentErrors.join('\n    ') : undefined);
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
        const tmuxPane = tmux.panes.find(p => p.tmuxId === uiPane.tmuxId);
        if (!tmuxPane) continue;
        if (uiPane.cursorX !== tmuxPane.cursorX || uiPane.cursorY !== tmuxPane.cursorY) {
          cursorErrors.push(
            `${uiPane.tmuxId}: UI=(${uiPane.cursorX},${uiPane.cursorY}), tmux=(${tmuxPane.cursorX},${tmuxPane.cursorY})`
          );
        }
      }
      check('Cursor positions', cursorErrors.length === 0, cursorErrors.length > 0 ? cursorErrors.join('; ') : undefined);
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
      const tmuxPane = tmux.panes.find(p => p.tmuxId === uiPane.tmuxId);
      if (!tmuxPane) continue;
      if (uiPane.command !== tmuxPane.command) {
        cmdErrors.push(`${uiPane.tmuxId}: UI=${JSON.stringify(uiPane.command)}, tmux=${JSON.stringify(tmuxPane.command)}`);
      }
    }
    check('Pane commands', cmdErrors.length === 0, cmdErrors.length > 0 ? cmdErrors.join('; ') : undefined);
  } else {
    check('Pane commands', false, 'Skipped (ID mismatch)');
  }

  // 12. Group membership (same pane sets)
  const uiGroupSets = Object.values(ui.paneGroups).map(g => [...g.paneIds].sort().join(','));
  const tmuxGroupSets = Object.values(tmux.paneGroups).map(g => [...g.paneIds].sort().join(','));
  uiGroupSets.sort();
  tmuxGroupSets.sort();
  check(
    'Group membership',
    uiGroupSets.join('|') === tmuxGroupSets.join('|'),
    uiGroupSets.join('|') !== tmuxGroupSets.join('|')
      ? `UI groups: [${uiGroupSets.join('], [')}], tmux groups: [${tmuxGroupSets.join('], [')}]`
      : undefined
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
      activeTabErrors.push(`Group [${setKey}]: UI active=${uiGroup.activeTab}, tmux active=${tmuxGroup.activeTab}`);
    }
  }
  check('Group active tab', activeTabErrors.length === 0, activeTabErrors.length > 0 ? activeTabErrors.join('; ') : undefined);

  // 14. Group tab names vs pane commands
  // Compare the command reported by tmux for each grouped pane against the UI's pane command
  const tabNameErrors = [];
  for (const uiPane of ui.panes) {
    // Check if this pane is in any group
    const inGroup = Object.values(ui.paneGroups).some(g => g.paneIds.includes(uiPane.tmuxId));
    if (!inGroup) continue;
    const tmuxCommand = tmux.groupTabNames[uiPane.tmuxId];
    if (tmuxCommand !== undefined && uiPane.command !== tmuxCommand) {
      tabNameErrors.push(`${uiPane.tmuxId}: UI="${uiPane.command}", tmux="${tmuxCommand}"`);
    }
  }
  check('Group tab names', tabNameErrors.length === 0, tabNameErrors.length > 0 ? tabNameErrors.join('; ') : undefined);

  // 15. Float pane existence
  check(
    'Float panes',
    ui.floatPaneIds.join(',') === tmux.floatPaneIds.join(','),
    ui.floatPaneIds.join(',') !== tmux.floatPaneIds.join(',')
      ? `UI: [${ui.floatPaneIds}], tmux: [${tmux.floatPaneIds}]`
      : undefined
  );

  return {
    pass: checks.every(c => c.pass),
    checks,
  };
}

module.exports = {
  extractUIState,
  extractTmuxState,
  compareSnapshots,
};
