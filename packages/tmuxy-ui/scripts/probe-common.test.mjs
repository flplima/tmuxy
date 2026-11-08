// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectStoryIds, writeProbeResults } from './lib/probe-common.mjs';

const story = (...tags) => ({ type: 'story', tags });
const entries = {
  'app--split-optimistic-timeline': story('v86', 'gate'),
  'app--resize-pane-drag': story('v86', 'gate'),
  'app-resize--resize-pane-drag-vertical': story('v86', 'gate'),
  'app--live': story('v86'),
  'app--slow-sweep': story('v86', 'nightly'),
  'tabs--overview': story(),
  'tabs--animated': story('nightly'),
  'tabs--docs': { type: 'docs', tags: ['v86', 'gate'] },
};

describe('selectStoryIds', () => {
  it('takes the v86 gate by its tag, not by id', () => {
    expect(selectStoryIds(entries, { v86: true, tier: 'gate' })).toEqual([
      'app--split-optimistic-timeline',
      'app--resize-pane-drag',
      'app-resize--resize-pane-drag-vertical',
    ]);
  });

  it('keeps v86 stories and the rest apart, whatever the tier', () => {
    expect(selectStoryIds(entries, { v86: false })).toEqual(['tabs--overview', 'tabs--animated']);
    expect(selectStoryIds(entries, { v86: false, tier: 'gate' })).toEqual([]);
  });

  it('leaves the nightly stories out of the commit tier', () => {
    expect(selectStoryIds(entries, { v86: false, tier: 'commit' })).toEqual(['tabs--overview']);
  });

  it('takes filters as substrings, or as whole ids when exact', () => {
    expect(selectStoryIds(entries, { v86: true, filters: ['resize-pane-drag'] })).toEqual([
      'app--resize-pane-drag',
      'app-resize--resize-pane-drag-vertical',
    ]);
    expect(
      selectStoryIds(entries, { v86: true, filters: ['app--resize-pane-drag'], exact: true }),
    ).toEqual(['app--resize-pane-drag']);
  });

  it('refuses a tier it does not know', () => {
    expect(() => selectStoryIds(entries, { v86: true, tier: 'gates' })).toThrow(/unknown tier/);
  });
});

describe('writeProbeResults', () => {
  let dir;
  let file;
  const read = () => JSON.parse(readFileSync(file, 'utf8')).stories;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'probe-results-'));
    file = join(dir, 'results.json');
  });
  afterEach(() => {
    delete process.env.PROBE_RESULTS_JSON;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a story that failed one attempt and passed another as not ok', () => {
    process.env.PROBE_RESULTS_JSON = file;
    writeProbeResults([
      { id: 'a', ok: false, reason: 'playFunctionThrewException', message: 'boom' },
      { id: 'a', ok: true },
      { id: 'b', ok: true },
      { id: 'b', ok: false, reason: 'probe-timeout' },
      { id: 'c', ok: true },
    ]);
    expect(read()).toEqual([
      { id: 'a', ok: false, reason: 'playFunctionThrewException', message: 'boom' },
      { id: 'b', ok: false, reason: 'probe-timeout', message: null },
      { id: 'c', ok: true, reason: null, message: null },
    ]);
  });

  it('counts a quarantined failure as ok', () => {
    process.env.PROBE_RESULTS_JSON = file;
    writeProbeResults([{ id: 'q', ok: false, reason: 'x' }], (id) => id === 'q');
    expect(read()).toEqual([{ id: 'q', ok: true, reason: 'x', message: null }]);
  });
});
