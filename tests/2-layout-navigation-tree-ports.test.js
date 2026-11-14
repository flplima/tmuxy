/**
 * Layout & Navigation E2E Tests (Sidebar Tree View: a pane's listening ports)
 */

const net = require('net');
const {
  describeE2E,
  runCommand,
  openSidebarKeyboard,
  waitForCondition,
} = require('./helpers/layout-helpers');

/** A port nothing listens on now, picked by the OS. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ==================== Scenario 6g: a pane's listening ports ====================

describeE2E("Scenario 6g: a pane's listening ports in the tree", {}, (ctx) => {
  test('a pane serving a page shows its port in its tree row, a click opens the page, and the port goes when the server stops', async () => {
    await ctx.setupPage();
    // A click opens the page through openExternalUrl (window.open on the
    // web): stubbed, so the test sees the address instead of leaving the page.
    await ctx.page.evaluate(() => {
      window.__opened = [];
      window.open = (url) => {
        window.__opened.push(url);
        return null;
      };
    });
    const paneId = await ctx.page.evaluate(() => window.app?.view().activePaneId);
    expect(paneId).toMatch(/^%\d+$/);

    // The user starts a small server in the pane, as they would.
    const port = await freePort();
    await runCommand(
      ctx.page,
      `node -e "require('http').createServer((q, r) => r.end('tmuxy-port-page')).listen(${port}, '127.0.0.1', () => console.log('LISTENING-' + ${port}))"`,
      `LISTENING-${port}`,
    );

    // The tree shows `:port` on that pane's row, drawn inside the column.
    await openSidebarKeyboard(ctx.page, 'left');
    const chip = `[data-testid="tree-pane-${paneId}"] .sidebar-tree-port[data-port="${port}"]`;
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(
          ({ selector, label }) => {
            const el = document.querySelector(selector);
            const column = document.querySelector('.sidebar-column-left');
            if (!el || !column || el.textContent !== label) return false;
            const r = el.getBoundingClientRect();
            const c = column.getBoundingClientRect();
            return r.width > 0 && r.left >= c.left && r.right <= c.right;
          },
          { selector: chip, label: `:${port}` },
        ),
      30000,
      `:${port} on the row of ${paneId}`,
    );
    // No other row claims it.
    expect(
      await ctx.page.evaluate(
        (p) => document.querySelectorAll(`.sidebar-tree-port[data-port="${p}"]`).length,
        port,
      ),
    ).toBe(1);

    // A click opens the page the server serves, on the host this page came
    // from, and does not activate the row it sits in.
    await ctx.page.click(chip);
    const opened = await ctx.page.evaluate(() => window.__opened);
    const pageHost = await ctx.page.evaluate(() => window.location.hostname);
    expect(opened).toEqual([`http://${pageHost}:${port}/`]);
    const served = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    expect(served).toBe('tmuxy-port-page');

    // The server stops; within a poll the port is gone from the row.
    await ctx.session.runAsOperator(`send-keys -t ${paneId} C-c`);
    await waitForCondition(
      ctx.page,
      async () => ctx.page.evaluate((selector) => !document.querySelector(selector), chip),
      30000,
      `:${port} to leave the row once its server stopped`,
    );
  });
});
