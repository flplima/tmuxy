/**
 * What the nightly story sweep reports, from tonight's results and the nights
 * before (`.github/workflows/nightly-v86.yml`, `scripts/nightly-ledger.mjs`).
 *
 * Every probe run writes a results file (`PROBE_RESULTS_JSON`): one entry per
 * story, `ok` or not. A story that failed in the sweep is run again in the
 * same night on a FRESH runner (the `reconfirm` jobs), so each story ends the
 * night with one verdict:
 *
 *   pass       passed in the sweep
 *   flaky      failed in the sweep, passed on the fresh runner
 *   confirmed  failed in the sweep and again on the fresh runner
 *
 * A confirmed failure is a defect (in the product or the story) and is
 * reported that night. A flaky one is not — on its own it says the sweep's
 * machine had a bad night, which the history of issues #87–#145 shows is what
 * most red nights were — but it is kept in the ledger, and a story that flakes
 * on `recurAt` nights out of the last `window` is reported too: a story that
 * keeps flaking is racing something, and that is a defect as well.
 *
 * Pure: no files, no network. The CLI reads the files and the runs.
 */

/** One night's results files (each `{ stories: [{ id, ok }] }`), merged by id: failing anywhere fails. */
export function mergeResults(files) {
  const byId = new Map();
  for (const file of files) {
    for (const s of file?.stories ?? []) {
      byId.set(s.id, (byId.get(s.id) ?? true) && s.ok);
    }
  }
  return byId;
}

/**
 * Tonight's verdict per story: the sweep's results, and the fresh runner's
 * for the stories that failed there. A failing story the re-run did not
 * report on (its job never ran) counts as confirmed: no second opinion is
 * not a reason to look away.
 */
export function verdicts(sweep, reconfirm) {
  const out = new Map();
  for (const [id, ok] of sweep) {
    if (ok) out.set(id, 'pass');
    else out.set(id, reconfirm.get(id) === true ? 'flaky' : 'confirmed');
  }
  return out;
}

/**
 * The report for tonight: `nights` is tonight's verdicts first, then earlier
 * nights' (a night is a Map id → verdict), newest first.
 */
export function ledger(nights, { window = 7, recurAt = 2 } = {}) {
  const [tonight = new Map(), ...earlier] = nights;
  const recent = [tonight, ...earlier].slice(0, window);
  const confirmed = [...tonight].filter(([, v]) => v === 'confirmed').map(([id]) => id);
  const flakyTonight = [...tonight].filter(([, v]) => v === 'flaky').map(([id]) => id);
  const recurring = flakyTonight
    .map((id) => ({
      id,
      nights: recent.filter((night) => night.get(id) === 'flaky').length,
    }))
    .filter((r) => r.nights >= recurAt);
  return {
    report: confirmed.length > 0 || recurring.length > 0,
    confirmed: confirmed.sort(),
    recurring: recurring.sort((a, b) => a.id.localeCompare(b.id)),
    flakyTonight: flakyTonight.sort(),
    nightsKnown: recent.length,
    window,
  };
}

/** The issue comment for a report, in Markdown. */
export function reportBody(result, { runUrl, sha, failures = new Map() }) {
  const lines = [];
  if (result.confirmed.length > 0) {
    lines.push(
      '**Failed in the sweep and again on a fresh runner** — a defect in the product or the story:',
      '',
    );
    for (const id of result.confirmed) {
      const why = failures.get(id);
      lines.push(`- \`${id}\`${why ? ` — ${why}` : ''}`);
    }
    lines.push('');
  }
  if (result.recurring.length > 0) {
    lines.push(
      `**Flaky on several nights** (passed on a fresh runner tonight, but has flaked on this many of the last ${result.nightsKnown} nights) — it is racing something:`,
      '',
    );
    for (const r of result.recurring) lines.push(`- \`${r.id}\` — ${r.nights} nights`);
    lines.push('');
  }
  lines.push(`Run: ${runUrl}`, `Commit: ${sha}`, '');
  lines.push(
    'The run log lists each failure with its error and stack; screenshots, DOM dumps and the results files are its artifacts. See docs/TESTS-STORYBOOK.md § "When the nightly reports".',
  );
  return lines.join('\n');
}
