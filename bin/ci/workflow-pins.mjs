#!/usr/bin/env node
/**
 * Every piece of someone else's code a workflow runs is named by an immutable
 * id, so the build that ran yesterday is the build that runs today:
 *
 * - a remote `uses:` names a full 40-character commit sha, never a tag or a
 *   branch (either can be moved to new code by whoever controls that repo —
 *   CVE-2025-30066 was a tag moved under every workflow that used it). The tag
 *   stays as a trailing comment, which is what Dependabot updates with the sha;
 * - a `cargo install` names `--version` and `--locked`, so neither the crate
 *   nor its dependency tree is whatever crates.io serves on the day.
 *
 *   bin/ci/workflow-pins.mjs   check .github/, exit 1 naming every offender
 */
import fs from 'node:fs';
import path from 'node:path';

const USES = /^\s*(?:- )?uses:\s*['"]?([^\s'"#]+)/;
const PINNED = /@[0-9a-f]{40}$/;
const CARGO_INSTALL = /\bcargo install\b(.*)$/;

/** `[line, problem]` for every unpinned action or install in one workflow or action file. */
export function unpinned(content) {
  const problems = [];
  content.split('\n').forEach((text, i) => {
    if (/^\s*#/.test(text)) return;
    const uses = USES.exec(text)?.[1];
    // `./` is this repository's own action; `docker://` is out of scope here.
    if (uses && !uses.startsWith('./') && !uses.startsWith('docker://') && !PINNED.test(uses)) {
      problems.push([i + 1, `${uses} is not pinned to a commit sha`]);
    }
    const install = CARGO_INSTALL.exec(text)?.[1];
    if (install !== undefined && !(/--version[ =]\S/.test(install) && /--locked\b/.test(install))) {
      problems.push([i + 1, `cargo install${install} needs --version and --locked`]);
    }
  });
  return problems;
}

/** The workflow and composite-action files under `root`/.github, relative to `root`. */
export function workflowFiles(root) {
  const workflows = path.join(root, '.github/workflows');
  const actions = path.join(root, '.github/actions');
  return [
    ...fs
      .readdirSync(workflows)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => `.github/workflows/${name}`),
    ...fs
      .readdirSync(actions)
      .filter((name) => fs.existsSync(path.join(actions, name, 'action.yml')))
      .map((name) => `.github/actions/${name}/action.yml`),
  ].sort();
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const errors = workflowFiles(root).flatMap((file) =>
    unpinned(fs.readFileSync(path.join(root, file), 'utf8')).map(
      ([line, problem]) => `${file}:${line}: ${problem}`,
    ),
  );
  if (errors.length > 0) {
    console.error(`Workflow pin check failed:\n\n${errors.map((e) => `- ${e}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Workflow pin check passed.');
}
