/**
 * The one comparison of the screen with tmux.
 *
 * The screen side is what is drawn: the tabs on the strip, the grid's panes
 * with their size in cells, which one is drawn active and their rows of text.
 * The tmux side is tmux's own answer (read-only queries, safe beside control
 * mode) for the tab the strip shows: nothing about either side is re-derived
 * here, so a bug in how the app builds its model from tmux shows as a
 * difference instead of being copied into the check.
 *
 * The screen follows tmux a round trip later, so a comparison waits for the
 * two to agree and fails with the differences left when they do not.
 */

const { tmuxExec } = require('./tmux-socket');
const { waitForCondition } = require('./browser');

/** What the screen draws (runs in the page). */
const readScreen = () => {
  const root = document.querySelector('.app-container');
  const cellW = root ? parseFloat(getComputedStyle(root).getPropertyValue('--cell-w')) : NaN;
  const shown = (el) => {
    if (el.closest('.pane-window-hidden')) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  const tabs = [...document.querySelectorAll('.tab-name[data-window-id]')].map((el) => ({
    id: el.dataset.windowId,
    active: el.classList.contains('tab-name-active'),
  }));
  const panes = [...document.querySelectorAll('.pane-container .pane-layout-item[data-pane-id]')]
    .filter(shown)
    .map((el) => {
      const content = el.querySelector('.terminal-content');
      const lines = content ? [...content.querySelectorAll('.terminal-line')] : [];
      return {
        id: el.dataset.paneId,
        active: el.matches('.pane-active') || el.querySelector('.pane-active') !== null,
        terminal: content !== null,
        cols: content ? Math.round(content.getBoundingClientRect().width / cellW) : null,
        rows: lines.map((line) => line.textContent || ''),
      };
    });
  return { tabs, panes };
};

/** A pane's screen, row by row, its blank leading rows kept. */
function captureRows(paneId) {
  return tmuxExec(`capture-pane -p -t ${paneId}`, { trim: false }).replace(/\n$/, '').split('\n');
}

/** What tmux holds for `session`, and for the panes of `tab`. */
function readTmux(session, tab, { content }) {
  const windows = tmuxExec(
    `list-windows -t ${session} -F '#{window_id}|#{window_active}|#{@tmuxy-window-type}|#{@tmuxy-float-parent}'`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, active, type, parent] = line.split('|');
      // Untagged is a tab (docs/TMUX-TAGS.md).
      return { id, active: active === '1', type: type || 'tab', parent };
    });
  const panes = tab
    ? tmuxExec(
        `list-panes -t ${tab} -F '#{pane_id}|#{pane_active}|#{pane_width}|#{pane_height}|#{alternate_on}|#{pane_in_mode}'`,
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [id, active, width, height, alternate, inMode] = line.split('|');
          return {
            id,
            active: active === '1',
            width: Number(width),
            height: Number(height),
            plain: alternate !== '1' && inMode !== '1',
            rows: content ? captureRows(id) : null,
          };
        })
    : [];
  return { windows, panes };
}

/** The differences between the screen and tmux; none when they agree. */
function differences(screen, tmux, { content, label }) {
  const out = [];
  const say = (line) => out.push(label ? `[${label}] ${line}` : line);
  const tabs = tmux.windows.filter((w) => w.type === 'tab');
  const stripIds = screen.tabs.map((t) => t.id);
  if (stripIds.join(' ') !== tabs.map((t) => t.id).join(' ')) {
    say(`tabs: the strip shows [${stripIds}], tmux has [${tabs.map((t) => t.id)}]`);
  }
  // tmux's current window is the float's own while a float is focused; the
  // strip shows the tab the float was opened over (`@tmuxy-float-parent`).
  const current = tmux.windows.find((w) => w.active);
  const currentTab = current?.type === 'float' && current.parent ? current.parent : current?.id;
  const stripActive = screen.tabs.find((t) => t.active)?.id;
  if (stripActive !== currentTab) {
    say(`active tab: the strip shows ${stripActive}, tmux is on ${currentTab}`);
  }
  const drawn = screen.panes.map((p) => p.id).sort();
  const held = tmux.panes.map((p) => p.id).sort();
  if (drawn.join(' ') !== held.join(' ')) {
    say(`panes: the grid draws [${drawn}], tmux's tab holds [${held}]`);
    return out;
  }
  const drawnActive = screen.panes.find((p) => p.active)?.id;
  const tmuxActive = tmux.panes.find((p) => p.active)?.id;
  if (drawnActive && drawnActive !== tmuxActive) {
    say(`active pane: the grid draws ${drawnActive}, tmux's is ${tmuxActive}`);
  }
  for (const pane of tmux.panes) {
    const shown = screen.panes.find((p) => p.id === pane.id);
    if (!shown.terminal) continue;
    if (Math.abs(shown.cols - pane.width) > 1) {
      say(`${pane.id} width: ${shown.cols} cells drawn, tmux's is ${pane.width}`);
    }
    if (Math.abs(shown.rows.length - pane.height) > 1) {
      say(`${pane.id} height: ${shown.rows.length} rows drawn, tmux's is ${pane.height}`);
    }
    if (!content || !pane.plain) continue;
    const rows = Math.min(shown.rows.length, pane.rows.length);
    for (let i = 0; i < rows; i++) {
      const drawnRow = shown.rows[i].slice(0, pane.width).trimEnd();
      const tmuxRow = pane.rows[i].trimEnd();
      if (drawnRow !== tmuxRow) {
        say(
          `${pane.id} row ${i}: drawn ${JSON.stringify(drawnRow)}, tmux ${JSON.stringify(tmuxRow)}`,
        );
        break;
      }
    }
  }
  return out;
}

/**
 * Wait until the screen shows what tmux holds for the session in the page's
 * URL: the strip's tabs and the active one, the grid's panes, the active pane,
 * each pane's size, and with `content` each plain pane's text (a pane in copy
 * mode or on the alternate screen is compared by its own test).
 */
async function assertScreenMatchesTmux(
  page,
  { content = false, label = '', timeout = 10000 } = {},
) {
  const session = new URL(page.url()).searchParams.get('session');
  if (!session)
    throw new Error(`assertScreenMatchesTmux: the page opens no session (${page.url()})`);
  let last = [];
  await waitForCondition(
    page,
    async () => {
      const screen = await page.evaluate(readScreen);
      const tab = screen.tabs.find((t) => t.active)?.id;
      last = differences(screen, readTmux(session, tab, { content }), { content, label });
      return last.length === 0;
    },
    timeout,
    () => `the screen to match tmux:\n  ${last.join('\n  ')}`,
  );
}

/** `assertScreenMatchesTmux` with the panes' text. */
async function assertContentMatch(page, label) {
  await assertScreenMatchesTmux(page, { content: true, label });
}

/**
 * Compare the active pane's drawn rows with `capture-pane` while it is on the
 * alternate screen, for a TUI's own rendering. `maxDiffs` rows may differ;
 * every `requireMarkers` string must be in both.
 */
async function assertAltScreenMatch(page, sessionName, { maxDiffs = 0, requireMarkers = [] } = {}) {
  const paneId = await page.evaluate(() => window.app.view().activePaneId);
  const [width, alternate] = tmuxExec(
    `display-message -p -t ${paneId} '#{pane_width}|#{alternate_on}'`,
  ).split('|');
  if (alternate !== '1') {
    throw new Error(`assertAltScreenMatch: ${paneId} is not on the alternate screen`);
  }
  const uiLines = (await page.evaluate(readScreen)).panes.find((p) => p.id === paneId)?.rows;
  if (!uiLines) throw new Error(`assertAltScreenMatch: ${paneId} is not drawn in the grid`);
  const tmuxLines = captureRows(paneId);
  const compared = Math.min(tmuxLines.length, uiLines.length);
  if (compared < 5) {
    throw new Error(
      `assertAltScreenMatch: too few comparable rows (tmux=${tmuxLines.length}, ui=${uiLines.length})`,
    );
  }
  const diffs = [];
  for (let row = 0; row < compared; row++) {
    const t = tmuxLines[row].trimEnd();
    const u = uiLines[row].slice(0, Number(width)).trimEnd();
    if (t !== u) diffs.push({ row, tmux: t.slice(0, 80), ui: u.slice(0, 80) });
  }
  if (diffs.length > maxDiffs) {
    const details = diffs
      .slice(0, 5)
      .map(
        (d) =>
          `  row ${d.row}:\n    tmux: ${JSON.stringify(d.tmux)}\n    ui:   ${JSON.stringify(d.ui)}`,
      )
      .join('\n');
    throw new Error(
      `Alt-screen rendering diverged from tmux capture-pane on ${diffs.length}/${compared} rows:\n${details}`,
    );
  }
  for (const marker of requireMarkers) {
    if (!tmuxLines.join('\n').includes(marker)) {
      throw new Error(
        `assertAltScreenMatch: marker ${JSON.stringify(marker)} missing from tmux capture`,
      );
    }
    if (!uiLines.join('\n').includes(marker)) {
      throw new Error(
        `assertAltScreenMatch: marker ${JSON.stringify(marker)} missing from the screen`,
      );
    }
  }
  return { tmuxLines, uiLines };
}

module.exports = { assertScreenMatchesTmux, assertContentMatch, assertAltScreenMatch };
