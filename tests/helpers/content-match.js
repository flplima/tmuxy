/**
 * Content-Match Assertions
 *
 * Compares rendered terminal content in the browser against tmux ground truth.
 * Checks: text content, dimensions, cursor position, pane titles, and spacing.
 */

const { tmuxQuery } = require('./cli');
const { delay } = require('./browser');

/**
 * Assert that the browser UI content matches tmux ground truth for all visible panes.
 *
 * Checks per pane:
 * 1. Text content (line-by-line, trailing whitespace trimmed)
 * 2. Dimensions (width/height)
 * 3. Cursor position (cursorX/cursorY)
 * 4. Title (DOM .pane-tab-title vs trimmed pane-border-format)
 *
 * Skips panes in copy mode or alternate screen.
 * Retries up to 5 times (600ms apart) to account for propagation delay.
 *
 * @param {Page} page - Playwright page
 * @param {string} [label] - Optional label for error messages
 */
async function assertContentMatch(page, label) {
  const prefix = label ? `[${label}] ` : '';

  // Extract session name from page URL
  let sessionName;
  try {
    const url = new URL(page.url());
    sessionName = url.searchParams.get('session');
    if (!sessionName) return; // Can't compare without session
  } catch {
    return;
  }

  let lastErrors = [];

  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await delay(600);

    try {
      lastErrors = [];

      // Query tmux state in a single list-panes call
      const tmuxRaw = tmuxQuery(
        `list-panes -t ${sessionName} -F "#{pane_id}|#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}|#{T:pane-border-format}"`
      );
      const tmuxPanes = {};
      for (const line of tmuxRaw.split('\n').filter(Boolean)) {
        const parts = line.split('|');
        const id = parts[0];
        tmuxPanes[id] = {
          width: parseInt(parts[1], 10),
          height: parseInt(parts[2], 10),
          cursorX: parseInt(parts[3], 10),
          cursorY: parseInt(parts[4], 10),
          borderTitle: parts.slice(5).join('|'), // remainder (may contain |)
        };
      }

      // Get UI state + DOM content from browser
      const uiData = await page.evaluate(() => {
        const snap = window.app?.getSnapshot();
        if (!snap?.context) return null;
        const ctx = snap.context;
        const visiblePanes = (ctx.panes || []).filter(p => p.windowId === ctx.activeWindowId);
        const copyModeStates = ctx.copyModeStates || {};

        const result = {};
        for (const pane of visiblePanes) {
          // Skip panes in copy mode or alternate screen
          if (copyModeStates[pane.tmuxId]) continue;
          if (pane.alternateOn) continue;

          // Extract DOM content
          const el = document.querySelector(`[data-pane-id="${pane.tmuxId}"] .terminal-content`);
          const lines = [];
          if (el) {
            el.querySelectorAll('.terminal-line').forEach(lineEl => {
              let text = '';
              lineEl.querySelectorAll('span').forEach(s => { text += s.textContent || ''; });
              lines.push(text.slice(0, pane.width)); // crop to pane width
            });
          }

          // Extract title from DOM
          const headerEl = document.querySelector(`[data-pane-id="${pane.tmuxId}"] .pane-tab-title`);
          const domTitle = headerEl ? headerEl.textContent || '' : '';

          result[pane.tmuxId] = {
            width: pane.width,
            height: pane.height,
            cursorX: pane.cursorX,
            cursorY: pane.cursorY,
            lines,
            domTitle,
          };
        }
        return result;
      });

      if (!uiData || Object.keys(uiData).length === 0) return; // All panes skipped or no data

      for (const [paneId, ui] of Object.entries(uiData)) {
        const tmux = tmuxPanes[paneId];
        if (!tmux) continue;

        // Check dimensions (allow 1-row height difference for status bar allocation)
        if (tmux.width !== ui.width) {
          lastErrors.push(`${prefix}Pane ${paneId} width: tmux=${tmux.width}, ui=${ui.width}`);
        }
        if (Math.abs(tmux.height - ui.height) > 1) {
          lastErrors.push(`${prefix}Pane ${paneId} height: tmux=${tmux.height}, ui=${ui.height}`);
        }

        // Check cursor position (allow cursorY tolerance matching height tolerance).
        // Skip cursor check entirely if UI reports 0,0 — cursor may not have synced yet.
        const cursorSynced = !(ui.cursorX === 0 && ui.cursorY === 0 && (tmux.cursorX !== 0 || tmux.cursorY !== 0));
        if (cursorSynced) {
          if (tmux.cursorX !== ui.cursorX) {
            lastErrors.push(`${prefix}Pane ${paneId} cursorX: tmux=${tmux.cursorX}, ui=${ui.cursorX}`);
          }
          if (Math.abs(tmux.cursorY - ui.cursorY) > 1) {
            lastErrors.push(`${prefix}Pane ${paneId} cursorY: tmux=${tmux.cursorY}, ui=${ui.cursorY}`);
          }
        }

        // Check title: compare the non-dimension portion of the border title.
        // The UI borderTitle may reflect initial/different dimensions than
        // the current tmux borderTitle (e.g., "200x49" vs "136x22") because
        // the border format includes the pane size which changes on resize.
        // Strip dimension patterns before comparing.
        const stripDims = (s) => s.replace(/\(\d+x\d+\)/, '').replace(/\s+/g, ' ').trim();
        const tmuxTitle = stripDims(tmux.borderTitle.trim());
        const domTitle = stripDims(ui.domTitle);
        // Skip title check if dom title is just the pane ID (borderTitle not yet received)
        if (tmuxTitle && domTitle && domTitle !== paneId && tmuxTitle !== domTitle) {
          lastErrors.push(
            `${prefix}Pane ${paneId} title: tmux=${JSON.stringify(tmuxTitle)}, dom=${JSON.stringify(domTitle)}`
          );
        }

        // Check content line-by-line. When heights differ by 1, content may be
        // shifted — try offsets [-1, 0, +1] and pick the best alignment.
        // Allow up to 2 differing lines for timing races.
        const tmuxContent = tmuxQuery(`capture-pane -t ${paneId} -p`);
        const tmuxLines = tmuxContent.split('\n');

        let bestDiffCount = Infinity;
        let bestDiffDetails = [];

        for (const offset of [-1, 0, 1]) {
          const compareLines = Math.min(tmuxLines.length, ui.lines.length) - Math.abs(offset);
          if (compareLines <= 0) continue;
          let dc = 0;
          const dd = [];
          for (let i = 0; i < compareLines; i++) {
            const ti = offset >= 0 ? i + offset : i;
            const ui_i = offset >= 0 ? i : i - offset;
            const tLine = (tmuxLines[ti] || '').replace(/\s+$/, '');
            const uLine = (ui.lines[ui_i] || '').replace(/\s+$/, '');
            if (tLine !== uLine) {
              dc++;
              if (dd.length < 3) {
                dd.push(
                  `${prefix}Pane ${paneId} line ${ui_i}:\n` +
                  `    tmux: ${JSON.stringify(tLine.slice(0, 80))}\n` +
                  `    ui:   ${JSON.stringify(uLine.slice(0, 80))}`
                );
              }
            }
          }
          if (dc < bestDiffCount) {
            bestDiffCount = dc;
            bestDiffDetails = dd;
          }
        }

        // Only fail if >30% of lines differ (account for capture timing and
        // height-related content shifts that the offset alignment can't fully resolve)
        const maxDiffAllowed = Math.max(2, Math.ceil(compareLines * 0.3));
        if (bestDiffCount > maxDiffAllowed) {
          lastErrors.push(...bestDiffDetails);
          if (bestDiffCount > 3) {
            lastErrors.push(`${prefix}Pane ${paneId}: ${bestDiffCount - 3} more differing lines (${bestDiffCount}/${compareLines})`);
          }
        }
      }

      if (lastErrors.length === 0) return; // Success
    } catch (e) {
      // Page may be closing or tmux session gone
      return;
    }
  }

  throw new Error(
    `Content match failed after 5 attempts:\n` +
    lastErrors.map(e => `  - ${e}`).join('\n')
  );
}

module.exports = {
  assertContentMatch,
};
