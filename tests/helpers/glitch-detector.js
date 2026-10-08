/**
 * Glitch Detector — the Playwright/Jest face of the glitch detector in
 * `packages/tmuxy-ui/src/stories/glitchRecorder.ts`. The collector runs in the
 * page (Playwright serialises its source), the classifier runs here, and both
 * are the very code the Storybook play functions use, so the two harnesses
 * cannot disagree about what a glitch is.
 *
 * Usage:
 *   const detector = new GlitchDetector(page);
 *   await detector.start({ scope: '.pane-layout' });
 *   // ... perform operation ...
 *   const result = await detector.stop();
 *   expect(result.summary.nodeFlickers).toBe(0);
 */

const { resolve } = require('node:path');

// Jest's own `require` cannot load an ES module and the E2E suite has no
// transform, so the shared source is loaded through Node's loader instead:
// `process.getBuiltinModule` hands back the real `module` builtin (Jest wraps
// the one `require('node:module')` returns), and Node ≥ 22.18 strips the types
// itself. The file keeps to erasable syntax for exactly this reason.
const { createRequire } = process.getBuiltinModule('module');
const {
  GLITCH_DEFAULTS,
  OPERATION_THRESHOLDS,
  analyzeGlitches,
  describeGlitches,
  glitchThresholds,
  startGlitchCollector,
} = createRequire(__filename)(
  resolve(__dirname, '../../packages/tmuxy-ui/src/stories/glitchRecorder.ts'),
);

/**
 * Default configuration for glitch detection. Rects are polled on a timer
 * rather than per animation frame: a page the suite drives may sit in a
 * background tab, where animation frames stop and timers do not.
 */
const DEFAULT_OPTIONS = {
  // CSS selector for the observation scope (must exist on page load)
  scope: '.pane-container',
  ...GLITCH_DEFAULTS,
  sizePollIntervalMs: 16,
};

class GlitchDetector {
  constructor(page) {
    this.page = page;
    this.isRunning = false;
  }

  /**
   * Start observing DOM mutations
   * @param {Object} options - Configuration options
   */
  async start(options = {}) {
    if (this.isRunning) {
      throw new Error('GlitchDetector is already running. Call stop() first.');
    }
    const { scope, ...config } = { ...DEFAULT_OPTIONS, ...options };
    this.config = config;
    this.isRunning = true;

    const started = await this.page.evaluate(
      `(() => {
        const collector = (${startGlitchCollector})(${JSON.stringify(scope)}, ${JSON.stringify(config)});
        window.__glitchCollector = collector;
        return collector !== null;
      })()`,
    );
    if (!started) {
      console.warn(`[GlitchDetector] Scope element not found: ${scope}`);
    }
  }

  /**
   * Stop observing and collect results
   * @returns {Object} The glitch report: flickers, churn, jumps and a summary
   */
  async stop() {
    if (!this.isRunning) {
      throw new Error('GlitchDetector is not running. Call start() first.');
    }
    this.isRunning = false;

    const recording = await this.page.evaluate(() => {
      const collector = window.__glitchCollector;
      delete window.__glitchCollector;
      return collector ? collector.stop() : null;
    });
    return analyzeGlitches(
      recording ?? { nodes: [], attrs: [], frames: [], durationMs: 0 },
      this.config,
    );
  }

  /**
   * Assert no glitches detected
   * @param {Object} options - `operation` names the threshold row; any other
   *   key overrides one threshold (nodeFlickers, attrChurnEvents, sizeJumps)
   * @throws {Error} If glitches exceed thresholds
   */
  async assertNoGlitches(options = {}) {
    const { operation = 'default', ...overrides } = options;
    const report = await this.stop();
    const failure = describeGlitches(operation, report, glitchThresholds(operation, overrides));
    if (failure) throw new Error(failure);
    return report;
  }
}

module.exports = { GlitchDetector, OPERATION_THRESHOLDS };
