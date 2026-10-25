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
const CHROME_WINDOW_TYPES = ['float', 'sidebar-left', 'sidebar-right'];

/**
 * Pane groups as tmux records them: every pane tagged with the same
 * `@tmuxy-group-id`, wherever it lives (the visible member in the session, the
 * rest parked in the stash session). Members are ordered like `group_members`
 * in packages/tmuxy-cli/bin/tmuxy/_lib and `buildGroupsFromPanes` in the UI: by `@tmuxy-group-pos`
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

const { compareSnapshots } = require('./snapshot-diff');

module.exports = {
  extractUIState,
  extractTmuxState,
  compareSnapshots,
};
