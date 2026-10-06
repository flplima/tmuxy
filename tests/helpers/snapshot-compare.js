/**
 * Snapshot Compare — Core Extraction + Comparison
 *
 * Captures "visible state" from both the tmuxy web UI (via browser JS)
 * and tmux CLI, then compares them to find mismatches. Read-only — no
 * interactions, no mutations.
 *
 * The one place tmux-side and UI-side state is extracted: the snapshot suite
 * compares the two in full (compareSnapshots), and consistency.js checks a
 * structural subset of the same extraction after every E2E test.
 */

const { execSync } = require('child_process');
const { tmuxCmd, tmuxEnv, tmuxExec } = require('./tmux-socket');

// ==================== UI State Extraction ====================

/**
 * Extract the full visible state from the browser via XState context + DOM.
 *
 * Single page.evaluate() call extracts:
 * - Tab windows (float and sidebar chrome excluded)
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

    // Tab windows
    const windows = (ctx.windows || [])
      .filter((w) => w.windowType === 'tab')
      .map((w) => ({ id: w.id, index: w.index, name: w.name, active: w.active }));

    // Panes in active window
    const visiblePanes = (ctx.panes || []).filter((p) => p.windowId === ctx.activeWindowId);
    const panes = visiblePanes.map((p) => ({
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
          if (!Array.isArray(cellLine)) {
            lines.push('');
            continue;
          }
          lines.push(cellLine.map((cell) => cell.c || '').join(''));
        }
      }
      // Fallback: if XState content is all-empty, read from DOM
      const hasContent = lines.some((l) => l.trim().length > 0);
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
    const activeWindowPaneIds = new Set(visiblePanes.map((p) => p.tmuxId));
    const groupActiveTabs = {};
    for (const [groupId, group] of Object.entries(paneGroups)) {
      const activePaneInGroup = group.paneIds.find((id) => activeWindowPaneIds.has(id));
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

/** Window types that are chrome, not tabs. A tab carries no type marker. */
const CHROME_WINDOW_TYPES = ['float', 'float-backdrop', 'sidebar-left', 'sidebar-right'];

/**
 * Pane groups as tmux records them: every pane tagged with the same
 * `@tmuxy-group-id`, wherever it lives (the visible member in the session, the
 * rest parked in the stash session). Members are ordered like `group_members`
 * in bin/tmuxy/_lib and `buildGroupsFromPanes` in the UI: by `@tmuxy-group-pos`
 * where a reorder set one, then by pane number. Only groups with a member in
 * `sessionName` and at least two members count, as in the UI.
 *
 * @returns {{paneGroups: Object, groupActiveTabs: Object, groupTabNames: Object}}
 */
function extractTmuxGroups(sessionName, activeWindowId) {
  const raw = tmuxExec(
    `list-panes -a -F "#{pane_id}|#{@tmuxy-group-id}|#{@tmuxy-group-pos}|#{session_name}|#{window_id}|#{pane_current_command}"`,
  );
  const byGroup = new Map();
  for (const line of raw.split('\n').filter(Boolean)) {
    const [paneId, groupId, pos, session, windowId, command] = line.split('|');
    if (!groupId) continue;
    const members = byGroup.get(groupId) || [];
    members.push({
      paneId,
      pos: pos === '' ? Infinity : parseInt(pos, 10),
      num: parseInt(paneId.slice(1), 10),
      session,
      windowId,
      command,
    });
    byGroup.set(groupId, members);
  }

  const paneGroups = {};
  const groupActiveTabs = {};
  const groupTabNames = {};
  for (const [groupId, members] of byGroup) {
    if (members.length < 2 || !members.some((m) => m.session === sessionName)) continue;
    members.sort((a, b) => a.pos - b.pos || a.num - b.num);
    paneGroups[groupId] = { paneIds: members.map((m) => m.paneId) };
    const activeTab = members.find(
      (m) => m.session === sessionName && m.windowId === activeWindowId,
    );
    groupActiveTabs[groupId] = activeTab ? activeTab.paneId : null;
    for (const m of members) groupTabNames[m.paneId] = m.command;
  }
  return { paneGroups, groupActiveTabs, groupTabNames };
}

/**
 * Extract the full visible state from tmux via read-only queries (safe with
 * control mode attached):
 * 1. list-windows — tabs and float windows of the session
 * 2. list-panes — active window panes with positions
 * 3. capture-pane — per visible pane content (skipped with `content: false`)
 * 4. list-panes -s — pane-to-window map (float panes, focus behind a float)
 * 5. list-panes -a — pane group membership
 *
 * @param {string} sessionName - tmux session name
 * @param {Object} [options]
 * @param {boolean} [options.content=true] - Capture each visible pane's text
 * @returns {Object|null}
 */
function extractTmuxState(sessionName, { content = true } = {}) {
  try {
    const allWindows = tmuxExec(
      `list-windows -t ${sessionName} -F "#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{@tmuxy-window-type}"`,
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, index, name, active, windowType] = line.split('|');
        return {
          id,
          index: parseInt(index, 10),
          name,
          active: active === '1',
          windowType: windowType || null,
        };
      });

    const windows = allWindows.filter((w) => !CHROME_WINDOW_TYPES.includes(w.windowType));
    const floatWindows = allWindows.filter((w) => w.windowType === 'float');

    const activeWindow = allWindows.find((w) => w.active);
    const activeWindowId = activeWindow?.id || null;

    const panes = tmuxExec(
      `list-panes -t ${sessionName} -F "#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}|#{pane_active}|#{pane_current_command}|#{pane_title}"`,
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => {
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

    const sessionPanes = tmuxExec(
      `list-panes -s -t ${sessionName} -F "#{pane_id}|#{window_id}|#{pane_active}"`,
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [paneId, windowId, active] = line.split('|');
        return { paneId, windowId, active: active === '1' };
      });

    // When a float window is active, its pane_active flag points at the float's
    // own pane, not the pane the user focused in a tab. Take the active pane of
    // the tab windows instead.
    let activePaneId;
    if (activeWindow?.windowType === 'float') {
      const tabIds = new Set(windows.map((w) => w.id));
      activePaneId = sessionPanes.find((p) => tabIds.has(p.windowId) && p.active)?.paneId || null;
    } else {
      activePaneId = panes.find((p) => p.active)?.tmuxId || null;
    }

    // capture-pane straight through execSync, not tmuxExec: tmuxExec trims, and
    // trimming strips the leading blank lines of the capture, which misaligns
    // line numbers against the UI's VT100 content.
    const paneContent = {};
    if (content) {
      for (const pane of panes) {
        const raw = execSync(`${tmuxCmd()} capture-pane -t ${pane.tmuxId} -p`, {
          encoding: 'utf-8',
          timeout: 30000,
          env: tmuxEnv(),
        });
        // Strip only the trailing newline that capture-pane always appends
        paneContent[pane.tmuxId] = raw.replace(/\n$/, '').split('\n');
      }
    }

    // Each float window holds exactly one pane.
    const floatPaneIds = floatWindows
      .map((fw) => sessionPanes.find((p) => p.windowId === fw.id)?.paneId)
      .filter(Boolean)
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
      ...extractTmuxGroups(sessionName, activeWindowId),
      floatPaneIds,
    };
  } catch {
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

module.exports = {
  extractUIState,
  extractTmuxState,
  compareSnapshots,
};
