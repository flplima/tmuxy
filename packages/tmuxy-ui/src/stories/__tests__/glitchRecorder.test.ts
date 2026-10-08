import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLITCH_DEFAULTS,
  OPERATION_THRESHOLDS,
  analyzeGlitches,
  describeGlitches,
  glitchThresholds,
  startGlitchCollector,
  type GlitchRecording,
} from '../glitchRecorder';

const analysis = {
  flickerWindowMs: GLITCH_DEFAULTS.flickerWindowMs,
  churnWindowMs: GLITCH_DEFAULTS.churnWindowMs,
  sizeJumpThreshold: GLITCH_DEFAULTS.sizeJumpThreshold,
};

const empty: GlitchRecording = { nodes: [], attrs: [], frames: [], durationMs: 0 };

describe('analyzeGlitches', () => {
  it('pairs an add and a remove of the same element inside the flicker window', () => {
    const report = analyzeGlitches(
      {
        ...empty,
        nodes: [
          { type: 'add', ts: 0, element: 'div.pane' },
          { type: 'remove', ts: 40, element: 'div.pane' },
          { type: 'add', ts: 500, element: 'div.pane' },
          { type: 'add', ts: 0, element: 'div.other' },
          { type: 'remove', ts: 300, element: 'div.other' },
        ],
      },
      analysis,
    );
    expect(report.flickers).toEqual([
      { element: 'div.pane', sequence: ['add', 'remove'], windowMs: 40 },
    ]);
    expect(report.summary.nodeFlickers).toBe(1);
    expect(report.summary.totalNodeMutations).toBe(5);
  });

  it('calls an attribute churned only past two rapid rewrites', () => {
    const rewrite = (ts: number, target = 'div.a') => ({
      ts,
      attr: 'style',
      oldValue: null,
      newValue: null,
      target,
    });
    const report = analyzeGlitches(
      {
        ...empty,
        attrs: [
          rewrite(0),
          rewrite(50),
          rewrite(100),
          rewrite(150),
          rewrite(0, 'div.b'),
          rewrite(50, 'div.b'),
          rewrite(100, 'div.b'),
        ],
      },
      analysis,
    );
    expect(report.churn).toEqual([{ target: 'div.a:style', changeCount: 4, rapidChanges: 3 }]);
  });

  it('counts a size jump between visible frames, not through 0x0 or a morph', () => {
    const frame = (ts: number, w: number, animating = false) => ({
      ts,
      panes: [{ id: '%1', w, h: 100, animating }],
    });
    const report = analyzeGlitches(
      {
        ...empty,
        frames: [
          frame(0, 100),
          frame(16, 200),
          frame(32, 0),
          frame(48, 300),
          frame(64, 400, true),
          frame(80, 500),
          frame(96, 510),
        ],
      },
      analysis,
    );
    expect(report.jumps).toEqual([
      { paneId: '%1', ts: 16, from: { w: 100, h: 100 }, to: { w: 200, h: 100 } },
    ]);
  });
});

describe('glitchThresholds', () => {
  it('layers the default, the operation row and overrides, and defaults an unknown row', () => {
    expect(glitchThresholds('split')).toEqual(OPERATION_THRESHOLDS.split);
    expect(glitchThresholds('split', { sizeJumps: 9 })).toEqual({
      ...OPERATION_THRESHOLDS.split,
      sizeJumps: 9,
    });
    expect(glitchThresholds('test')).toEqual(OPERATION_THRESHOLDS.default);
  });
});

describe('describeGlitches', () => {
  it('is silent within budget and names every exceeded budget', () => {
    const report = analyzeGlitches(
      {
        ...empty,
        durationMs: 250,
        frames: [
          { ts: 0, panes: [{ id: '%1', w: 100, h: 100, animating: false }] },
          { ts: 16, panes: [{ id: '%1', w: 200, h: 100, animating: false }] },
        ],
      },
      analysis,
    );
    expect(describeGlitches('zoom', report, glitchThresholds('zoom'))).toBeNull();
    const message = describeGlitches('default', report, glitchThresholds('default'));
    expect(message).toContain('glitches detected during "default" (250ms');
    expect(message).toContain('size jumps: 1 (max 0)');
    expect(message).toContain('%1 at 16ms: 100x100 → 200x100');
    expect(message).not.toContain('node flickers');
  });
});

describe('startGlitchCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('records node and attribute mutations, skipping ignored subtrees', async () => {
    document.body.innerHTML =
      '<div class="pane-layout"><div class="pane-layout-item" data-pane-id="%1"><div class="terminal-content"></div></div></div>';
    const root = document.querySelector('.pane-layout')!;
    const collector = startGlitchCollector(root, { ...GLITCH_DEFAULTS, sizePollIntervalMs: 16 })!;
    const item = root.querySelector('.pane-layout-item')!;
    // One commit writing two style properties is one net change, not two.
    (item as HTMLElement).style.left = '1px';
    (item as HTMLElement).style.top = '2px';
    item.appendChild(document.createElement('span'));
    // Churn under the ignored terminal subtree must not count.
    root.querySelector('.terminal-content')!.appendChild(document.createElement('b'));
    await Promise.resolve();
    vi.advanceTimersByTime(40);
    const recording = collector.stop();
    expect(recording.attrs).toHaveLength(1);
    expect(recording.attrs[0]).toMatchObject({
      attr: 'style',
      target: 'div.pane-layout-item[pane=%1]',
    });
    expect(recording.nodes).toEqual([
      expect.objectContaining({ type: 'add', element: 'span[pane=%1]' }),
    ]);
    expect(recording.frames.length).toBeGreaterThanOrEqual(2);
    expect(recording.frames[0].panes[0]).toMatchObject({ id: '%1', animating: false });
  });

  it('returns null for a selector that matches nothing', () => {
    expect(startGlitchCollector('.nope', GLITCH_DEFAULTS)).toBeNull();
  });

  it("loads through Node's own loader, the way the Jest E2E helper needs it", () => {
    // `tests/helpers/glitch-detector.js` cannot go through a bundler; this
    // keeps the file in the erasable-syntax subset Node can strip itself.
    const { createRequire } = process.getBuiltinModule('module');
    const loaded = createRequire(import.meta.url)('../glitchRecorder.ts');
    expect(typeof loaded.startGlitchCollector).toBe('function');
    expect(String(loaded.startGlitchCollector)).toMatch(/^function startGlitchCollector\(\s*scope/);
    expect(String(loaded.startGlitchCollector)).not.toMatch(/: Element/);
    expect(loaded.glitchThresholds('kill')).toEqual(OPERATION_THRESHOLDS.kill);
  });
});
