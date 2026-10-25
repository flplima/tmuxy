import { describe, expect, it } from 'vitest';
// The repo's one vitest root is this package; bin/ has no runner of its own,
// so the rules that decide which CI jobs a push may skip are tested from here.
import { decide } from '../../../bin/ci/ci-changes.mjs';

const EVERYTHING = {
  desktop: true,
  v86: true,
  'macos-rust': true,
  audit: true,
  'nightly-e2e': true,
};

describe('which CI jobs a push can skip', () => {
  it('runs everything when the base cannot be reached', () => {
    expect(decide(null)).toEqual(EVERYTHING);
  });

  it('runs everything when the rules themselves changed', () => {
    expect(decide(['bin/ci/ci-changes.mjs'])).toEqual(EVERYTHING);
  });

  it('a prose-only push skips the desktop and v86 jobs, and triggers nothing', () => {
    expect(decide(['docs/TESTS.md', 'README.md', '.agents/skills/x/SKILL.md'])).toEqual({
      desktop: false,
      v86: false,
      'macos-rust': false,
      audit: false,
      'nightly-e2e': false,
    });
  });

  it('a web E2E suite or helper adds the nightly tier; app code, the CLI and desktop suites do not', () => {
    for (const file of [
      'tests/4-session-connectivity-multi.test.js',
      'tests/helpers/browser.js',
      'tests/e2e-suites.json',
      'bin/ci/e2e-plan.mjs',
    ]) {
      expect(decide([file]), file).toMatchObject({ 'nightly-e2e': true });
    }
    for (const file of [
      'tests/tauri/tauri-app-ipc.test.js',
      'tests/cli/pane.test.sh',
      'packages/tmuxy-ui/src/components/SessionMenu.tsx',
    ]) {
      expect(decide([file]), file).toMatchObject({ 'nightly-e2e': false });
    }
  });

  it('a UI component change runs both, a story-only change only the v86 probe', () => {
    expect(decide(['packages/tmuxy-ui/src/components/SessionMenu.tsx'])).toMatchObject({
      desktop: true,
      v86: true,
    });
    expect(decide(['packages/tmuxy-ui/src/stories/TabActions.stories.tsx'])).toMatchObject({
      desktop: false,
      v86: true,
    });
  });

  it('a server change runs the desktop job (it links the server) but not the v86 probe', () => {
    expect(decide(['packages/tmuxy-server/src/sse.rs'])).toMatchObject({
      desktop: true,
      v86: false,
    });
  });

  it('a web E2E suite runs neither, the desktop suites run the desktop job', () => {
    expect(decide(['tests/4-session-connectivity-multi.test.js'])).toMatchObject({
      desktop: false,
      v86: false,
    });
    expect(decide(['tests/tauri/tauri-app-ipc.test.js'])).toMatchObject({ desktop: true });
    expect(decide(['tests/helpers/browser.js'])).toMatchObject({ desktop: true });
  });

  it('the CLI and the shipped confs are baked into both', () => {
    for (const file of [
      'bin/tmuxy-cli',
      'bin/tmuxy/pane-float',
      'packages/tmuxy-core/assets/tmuxy.conf',
    ]) {
      expect(decide([file]), file).toMatchObject({ desktop: true, v86: true });
    }
  });

  it('a file no rule names runs everything skippable', () => {
    expect(decide(['Cargo.toml', 'some/new/place.rs'])).toMatchObject({
      desktop: true,
      v86: true,
    });
  });

  it('one relevant file among irrelevant ones is enough to run a job', () => {
    expect(decide(['docs/TESTS.md', 'packages/tmuxy-wasm/src/lib.rs'])).toMatchObject({
      desktop: false,
      v86: true,
    });
  });

  it('a lockfile triggers the audit; the macOS cargo test follows its own list', () => {
    expect(decide(['package-lock.json'])).toMatchObject({ audit: true, 'macos-rust': false });
    expect(decide(['Cargo.lock'])).toMatchObject({ audit: true, 'macos-rust': true });
    expect(decide(['packages/tmuxy-core/src/control_mode/connection.rs'])).toMatchObject({
      'macos-rust': true,
      audit: false,
    });
    expect(decide(['packages/tmuxy-core/src/lib.rs'])).toMatchObject({ 'macos-rust': false });
  });

  it('this workflow and its actions run everything; another workflow runs nothing', () => {
    expect(decide(['.github/workflows/lint-and-tests.yml'])).toEqual(EVERYTHING);
    expect(decide(['.github/actions/install-webkit/action.yml'])).toMatchObject({
      desktop: true,
      v86: true,
    });
    expect(decide(['.github/workflows/nightly-perf.yml'])).toMatchObject({
      desktop: false,
      v86: false,
      audit: false,
    });
  });
});
