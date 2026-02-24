/**
 * Glitch Detector
 *
 * A MutationObserver + ResizeObserver harness to detect unintended DOM mutations
 * (flicker, layout shifts, attribute churn, size jumps) during UI state transitions.
 *
 * Usage:
 *   const detector = new GlitchDetector(page);
 *   await detector.start({ scope: '.pane-layout' });
 *   // ... perform operation ...
 *   const result = await detector.stop();
 *   expect(result.summary.nodeFlickers).toBe(0);
 */

/**
 * Default configuration for glitch detection
 */
const DEFAULT_OPTIONS = {
  // CSS selector for the observation scope (must exist on page load)
  scope: '.pane-container',

  // Selectors to ignore (high-frequency expected mutations)
  ignoreSelectors: ['.terminal-content', '.terminal-cursor', '.terminal-line'],

  // Attributes to track for churn detection
  attributeFilter: ['class', 'style', 'data-active', 'data-pane-id'],

  // Attributes to ignore on elements with CSS transitions
  ignoreAttributes: [],

  // Time window for detecting flicker (add→remove→add cycles)
  flickerWindowMs: 100,

  // Time window for detecting attribute churn
  churnWindowMs: 200,

  // Size polling interval (~60fps)
  sizePollIntervalMs: 16,

  // Minimum size change to consider a jump (in pixels)
  sizeJumpThreshold: 20,

  // Time to wait for DOM to settle before considering operation complete
  quietPeriodMs: 200,
};

/**
 * Default thresholds for different operations
 */
const OPERATION_THRESHOLDS = {
  // Split: allow size jumps as panes resize to accommodate new pane
  // CSS transitions (250ms) on .pane-layout-item cause ~12 jumps at 60fps polling
  split: { nodeFlickers: 0, attrChurnEvents: 0, sizeJumps: 20 },
  // Kill: allow size jumps as remaining panes expand (same CSS transition reason)
  kill: { nodeFlickers: 0, attrChurnEvents: 0, sizeJumps: 20 },
  resize: { nodeFlickers: 0, attrChurnEvents: 2, sizeJumps: 0 },
  drag: { nodeFlickers: 0, attrChurnEvents: 4, sizeJumps: 0 },
  windowSwitch: { nodeFlickers: 0, attrChurnEvents: 0, sizeJumps: 0 },
  groupSwitch: { nodeFlickers: 0, attrChurnEvents: 0, sizeJumps: 0 },
  zoom: { nodeFlickers: 0, attrChurnEvents: 0, sizeJumps: 1 },
  default: { nodeFlickers: 0, attrChurnEvents: 0, sizeJumps: 0 },
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

    const config = { ...DEFAULT_OPTIONS, ...options };
    this.config = config;
    this.isRunning = true;

    // Inject observers into the browser context
    await this.page.evaluate((config) => {
      // Initialize data storage
      window.__glitchData = {
        startTime: performance.now(),
        nodes: [],      // Node additions/removals
        attributes: [], // Attribute changes
        sizes: [],      // Size snapshots
        config: config,
      };

      const data = window.__glitchData;
      const ignoreSelectors = config.ignoreSelectors || [];

      // Helper: check if element should be ignored
      const shouldIgnore = (el) => {
        if (!el || !el.matches) return true;
        return ignoreSelectors.some(sel => {
          try {
            return el.matches(sel) || el.closest(sel);
          } catch {
            return false;
          }
        });
      };

      // Helper: get element identifier
      const getElementId = (el) => {
        if (!el) return 'null';
        const tag = el.tagName?.toLowerCase() || 'unknown';
        const classes = el.className?.split?.(' ').filter(c => c).slice(0, 3).join('.') || '';
        const paneId = el.dataset?.paneId || el.closest?.('[data-pane-id]')?.dataset?.paneId || '';
        return `${tag}${classes ? '.' + classes : ''}${paneId ? '[pane=' + paneId + ']' : ''}`;
      };

      // Find scope element
      const scopeEl = document.querySelector(config.scope);
      if (!scopeEl) {
        console.warn(`[GlitchDetector] Scope element not found: ${config.scope}`);
        return;
      }

      // Create MutationObserver for node and attribute changes
      data.observer = new MutationObserver((mutations) => {
        const ts = performance.now() - data.startTime;

        for (const m of mutations) {
          // Skip ignored elements
          if (shouldIgnore(m.target)) continue;

          if (m.type === 'childList') {
            // Track node additions
            for (const node of m.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              if (shouldIgnore(node)) continue;

              data.nodes.push({
                type: 'add',
                ts,
                target: getElementId(m.target),
                element: getElementId(node),
                elementRef: new WeakRef(node),
              });
            }

            // Track node removals
            for (const node of m.removedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              if (shouldIgnore(node)) continue;

              data.nodes.push({
                type: 'remove',
                ts,
                target: getElementId(m.target),
                element: getElementId(node),
              });
            }
          } else if (m.type === 'attributes') {
            // Skip ignored attributes
            if (config.ignoreAttributes?.includes(m.attributeName)) continue;

            data.attributes.push({
              ts,
              attr: m.attributeName,
              oldValue: m.oldValue,
              newValue: m.target.getAttribute(m.attributeName),
              target: getElementId(m.target),
            });
          }
        }
      });

      // Start observing
      data.observer.observe(scopeEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: config.attributeFilter,
      });

      // Start size polling
      data.sizeInterval = setInterval(() => {
        const ts = performance.now() - data.startTime;
        const panes = document.querySelectorAll('.pane-layout-item, .pane-wrapper');

        const snapshot = {
          ts,
          panes: Array.from(panes).map(p => {
            const r = p.getBoundingClientRect();
            return {
              id: p.dataset?.paneId || getElementId(p),
              w: Math.round(r.width),
              h: Math.round(r.height),
              x: Math.round(r.left),
              y: Math.round(r.top),
            };
          }),
        };

        data.sizes.push(snapshot);

        // Limit size history to prevent memory bloat
        if (data.sizes.length > 500) {
          data.sizes = data.sizes.slice(-250);
        }
      }, config.sizePollIntervalMs);

    }, config);
  }

  /**
   * Stop observing and collect results
   * @returns {Object} Collected data with analysis
   */
  async stop() {
    if (!this.isRunning) {
      throw new Error('GlitchDetector is not running. Call start() first.');
    }

    this.isRunning = false;

    // Collect data from browser and disconnect observers
    const rawData = await this.page.evaluate(() => {
      const data = window.__glitchData;
      if (!data) return null;

      // Disconnect observers
      if (data.observer) {
        data.observer.disconnect();
      }
      if (data.sizeInterval) {
        clearInterval(data.sizeInterval);
      }

      // Clean up WeakRefs before returning (can't be serialized)
      const nodes = data.nodes.map(n => {
        const { elementRef, ...rest } = n;
        return rest;
      });

      return {
        nodes,
        attributes: data.attributes,
        sizes: data.sizes,
        config: data.config,
        duration: performance.now() - data.startTime,
      };
    });

    if (!rawData) {
      return {
        nodes: [],
        attributes: [],
        sizes: [],
        summary: { nodeFlickers: 0, attrChurnEvents: 0, sizeJumps: 0, duration: 0 },
        flickers: [],
        churn: [],
        jumps: [],
      };
    }

    // Analyze the data
    const analysis = this._analyze(rawData);

    return {
      ...rawData,
      ...analysis,
    };
  }

  /**
   * Analyze raw data for glitches
   * @private
   */
  _analyze(data) {
    const config = this.config;
    const flickers = [];
    const churn = [];
    const jumps = [];

    // Detect node flickers (add→remove or remove→add cycles within window)
    const nodesByElement = new Map();
    for (const n of data.nodes) {
      const key = n.element;
      if (!nodesByElement.has(key)) {
        nodesByElement.set(key, []);
      }
      nodesByElement.get(key).push(n);
    }

    for (const [element, events] of nodesByElement) {
      // Look for add→remove→add or remove→add→remove patterns
      for (let i = 0; i < events.length - 1; i++) {
        const curr = events[i];
        const next = events[i + 1];

        if (curr.type !== next.type && (next.ts - curr.ts) < config.flickerWindowMs) {
          // Found a potential flicker
          flickers.push({
            element,
            sequence: [curr, next],
            windowMs: next.ts - curr.ts,
          });
        }
      }
    }

    // Detect attribute churn (same attr changing rapidly)
    const attrByTarget = new Map();
    for (const a of data.attributes) {
      const key = `${a.target}:${a.attr}`;
      if (!attrByTarget.has(key)) {
        attrByTarget.set(key, []);
      }
      attrByTarget.get(key).push(a);
    }

    for (const [key, events] of attrByTarget) {
      // Count changes within churn window
      let churnCount = 0;
      for (let i = 1; i < events.length; i++) {
        if ((events[i].ts - events[i - 1].ts) < config.churnWindowMs) {
          churnCount++;
        }
      }

      if (churnCount > 2) {
        churn.push({
          target: key,
          changeCount: events.length,
          rapidChanges: churnCount,
          events: events.slice(0, 10), // Limit for readability
        });
      }
    }

    // Detect size jumps
    for (let i = 1; i < data.sizes.length; i++) {
      const prev = data.sizes[i - 1];
      const curr = data.sizes[i];

      for (const pane of curr.panes) {
        const prevPane = prev.panes.find(p => p.id === pane.id);
        if (!prevPane) continue;

        const dw = Math.abs(pane.w - prevPane.w);
        const dh = Math.abs(pane.h - prevPane.h);

        if (dw > config.sizeJumpThreshold || dh > config.sizeJumpThreshold) {
          jumps.push({
            paneId: pane.id,
            ts: curr.ts,
            from: { w: prevPane.w, h: prevPane.h },
            to: { w: pane.w, h: pane.h },
            delta: { w: dw, h: dh },
          });
        }
      }
    }

    return {
      flickers,
      churn,
      jumps,
      summary: {
        nodeFlickers: flickers.length,
        attrChurnEvents: churn.length,
        sizeJumps: jumps.length,
        totalNodeMutations: data.nodes.length,
        totalAttrMutations: data.attributes.length,
        duration: data.duration,
      },
    };
  }

  /**
   * Assert no glitches detected
   * @param {Object} options - Threshold options
   * @param {string} options.operation - Operation type for threshold lookup
   * @throws {Error} If glitches exceed thresholds
   */
  async assertNoGlitches(options = {}) {
    const result = await this.stop();
    const thresholds = {
      ...OPERATION_THRESHOLDS.default,
      ...(options.operation ? OPERATION_THRESHOLDS[options.operation] : {}),
      ...options,
    };

    const failures = [];

    if (result.summary.nodeFlickers > thresholds.nodeFlickers) {
      failures.push(
        `Node flickers: ${result.summary.nodeFlickers} (max: ${thresholds.nodeFlickers})\n` +
        result.flickers.map(f =>
          `  - ${f.element}: ${f.sequence.map(s => s.type).join('→')} in ${f.windowMs.toFixed(1)}ms`
        ).join('\n')
      );
    }

    if (result.summary.attrChurnEvents > thresholds.attrChurnEvents) {
      failures.push(
        `Attribute churn: ${result.summary.attrChurnEvents} (max: ${thresholds.attrChurnEvents})\n` +
        result.churn.map(c =>
          `  - ${c.target}: ${c.changeCount} changes (${c.rapidChanges} rapid)`
        ).join('\n')
      );
    }

    if (result.summary.sizeJumps > thresholds.sizeJumps) {
      failures.push(
        `Size jumps: ${result.summary.sizeJumps} (max: ${thresholds.sizeJumps})\n` +
        result.jumps.map(j =>
          `  - ${j.paneId} at ${j.ts.toFixed(1)}ms: ${j.from.w}x${j.from.h} → ${j.to.w}x${j.to.h}`
        ).join('\n')
      );
    }

    if (failures.length > 0) {
      throw new Error(
        `Glitch detected during "${options.operation || 'operation'}":\n\n` +
        failures.join('\n\n') +
        `\n\nTimeline summary:\n` +
        `  Duration: ${result.summary.duration.toFixed(1)}ms\n` +
        `  Total node mutations: ${result.summary.totalNodeMutations}\n` +
        `  Total attr mutations: ${result.summary.totalAttrMutations}`
      );
    }

    return result;
  }

  /**
   * Format a timeline of events for debugging
   * @param {Object} result - Result from stop()
   * @returns {string} Formatted timeline
   */
  static formatTimeline(result) {
    const events = [
      ...result.nodes.map(n => ({ ...n, kind: 'node' })),
      ...result.attributes.map(a => ({ ...a, kind: 'attr' })),
    ].sort((a, b) => a.ts - b.ts);

    return events.map(e => {
      const ts = `+${e.ts.toFixed(0)}ms`.padStart(8);
      if (e.kind === 'node') {
        return `${ts}  ${e.target}: ${e.type === 'add' ? '+' : '-'}${e.element}`;
      } else {
        return `${ts}  ${e.target}.${e.attr}: "${e.oldValue}" → "${e.newValue}"`;
      }
    }).join('\n');
  }
}

module.exports = { GlitchDetector, OPERATION_THRESHOLDS, DEFAULT_OPTIONS };
