#!/usr/bin/env node
/**
 * Whether a Dependabot PR is one `dependabot actions merge` may merge unread:
 * it moves the commit pin of GitHub's own `actions/*` and touches nothing
 * else. A third-party action is code from someone else's account running with
 * this repository's tokens, so its bump waits for a person.
 *
 *   gh pr diff <n> | bin/ci/actions-bump.mjs    exit 0 if mergeable, 1 with the reasons
 */
import { readFileSync } from 'node:fs';

const WORKFLOW_FILE = /^\.github\/(?:workflows\/[\w.-]+|actions\/[\w.-]+\/action)\.ya?ml$/;
/** A `uses:` line pinning a GitHub-owned action to a full commit sha, tag in a comment. */
const GITHUB_OWNED_PIN =
  /^\s*(?:- )?uses: actions\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40}(?: # [\w.-]+)?\s*$/;
/** The only header lines an in-place edit has; anything else adds, removes or renames a file. */
const EDIT_HEADER = /^(?:index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?|--- a\/\S+|\+\+\+ b\/\S+)$/;

/** The reasons `diff` cannot be merged unread; none means it can. */
export function refusals(diff) {
  const reasons = [];
  let files = 0;
  let inHeader = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files++;
      inHeader = true;
      const paths = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!paths) {
        reasons.push(`cannot read the file names in: ${line}`);
        continue;
      }
      for (const file of new Set(paths.slice(1))) {
        if (!WORKFLOW_FILE.test(file)) reasons.push(`touches ${file}, not a workflow or action`);
      }
    } else if (line.startsWith('@@')) {
      inHeader = false;
    } else if (inHeader) {
      if (!EDIT_HEADER.test(line)) reasons.push(`does more than edit a file in place: ${line}`);
    } else if (/^[+-]/.test(line) && !GITHUB_OWNED_PIN.test(line.slice(1))) {
      reasons.push(`changes a line that is not a pinned actions/* step: ${line.trim()}`);
    }
  }
  if (files === 0) reasons.push('the diff is empty');
  return reasons;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const reasons = refusals(readFileSync(0, 'utf8'));
  for (const reason of reasons) console.log(reason);
  process.exit(reasons.length === 0 ? 0 : 1);
}
