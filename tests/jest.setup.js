// Jest setup for E2E tests

// Increase timeout for all tests
jest.setTimeout(60000);

// Global error handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Cold-start warmup: absorb first-run latency (browser launch, server SSE init,
// control mode attachment) so Scenario 1 doesn't bear the cost.
const { getBrowser, waitForServer, navigateToSession, waitForSessionReady, delay } = require('./helpers/browser');
const { TMUXY_URL } = require('./helpers/config');

beforeAll(async () => {
  console.log('[warmup] Starting cold-start warmup...');
  const warmupStart = Date.now();

  try {
    await waitForServer(TMUXY_URL, 15000);
    const browser = await getBrowser();
    const context = await browser._browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const warmupSession = `warmup_${Date.now()}`;
    await navigateToSession(page, warmupSession);

    try {
      await waitForSessionReady(page, warmupSession);
    } catch {
      // Warmup session readiness is best-effort
      console.log('[warmup] Session readiness check timed out (non-fatal)');
    }

    // Kill the warmup session and close the page
    try {
      await page.evaluate(async () => {
        await window._adapter?.invoke('run_tmux_command', { command: 'kill-session' });
      });
    } catch {
      // Best effort
    }

    await page.close().catch(() => {});
    await delay(2000); // Let server clean up

    console.log(`[warmup] Done in ${Date.now() - warmupStart}ms`);
  } catch (error) {
    console.log(`[warmup] Failed (non-fatal): ${error.message}`);
  }
}, 60000);
