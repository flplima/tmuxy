/**
 * The quarantine policy shared by both story probes.
 *
 * A quarantined story still RUNS and is still REPORTED, its failure just does
 * not turn the job red. Quarantine is a stopgap for a failure that is
 * understood but not yet fixed — never a parking lot, which is what the policy
 * below exists to prevent: the list is capped, every entry carries a reason and
 * an ISO expiry, and on the expiry date the entry stops shielding so someone
 * has to fix, delete or consciously renew it.
 *
 * scripts/probe-stories.mjs reads probe-quarantine.json (the deterministic
 * stories, plus a11y rules); scripts/probe-spikes.mjs reads
 * probe-quarantine-v86.json (stories run against the real tmux in the guest).
 */
import { readFileSync } from 'node:fs';

/**
 * Read a quarantine list and check it against the policy. A list that breaks
 * the policy stops the run: a silently over-long or undated list is how
 * quarantine turns into permanent cover for a broken suite.
 */
export function loadQuarantine(path) {
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const max = file.maxEntries;
  const entries = file.entries ?? [];
  const problems = [];
  if (!Number.isInteger(max) || max < 1) problems.push('maxEntries must be a positive integer');
  if (!Array.isArray(entries)) problems.push('entries must be an array');
  if (Array.isArray(entries) && entries.length > max) {
    problems.push(
      `${entries.length} quarantined stories exceeds the cap of ${max} — fix or delete some before adding more`,
    );
  }
  const checkDated = (entry, where) => {
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(`${where}: missing reason`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? '')) {
      problems.push(`${where}: expires must be a YYYY-MM-DD date`);
    } else if (Number.isNaN(Date.parse(entry.expires))) {
      problems.push(`${where}: expires is not a real date`);
    }
  };

  const byId = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const where = `entry ${JSON.stringify(entry.id ?? '(no id)')}`;
    if (typeof entry.id !== 'string' || entry.id === '') problems.push(`${where}: missing id`);
    checkDated(entry, where);
    if (byId.has(entry.id)) problems.push(`${where}: listed twice`);
    byId.set(entry.id, entry);
  }

  // a11y entries shield ONE axe rule, on one story or (with id "*") on all of
  // them. Same policy: capped, dated, and each says why. Only the
  // deterministic probe has them; a list without the section is fine.
  const hasA11y = file.a11yEntries !== undefined || file.maxA11yEntries !== undefined;
  const a11yMax = file.maxA11yEntries;
  const a11yEntries = file.a11yEntries ?? [];
  if (hasA11y) {
    if (!Number.isInteger(a11yMax) || a11yMax < 1) {
      problems.push('maxA11yEntries must be a positive integer');
    }
    if (!Array.isArray(a11yEntries)) problems.push('a11yEntries must be an array');
    if (Array.isArray(a11yEntries) && a11yEntries.length > a11yMax) {
      problems.push(
        `${a11yEntries.length} quarantined a11y rules exceeds the cap of ${a11yMax} — fix some before adding more`,
      );
    }
  }
  const a11y = [];
  for (const entry of Array.isArray(a11yEntries) ? a11yEntries : []) {
    const where = `a11y entry ${JSON.stringify(`${entry.id ?? '?'}/${entry.rule ?? '?'}`)}`;
    if (typeof entry.rule !== 'string' || entry.rule === '')
      problems.push(`${where}: missing rule`);
    if (typeof entry.id !== 'string' || entry.id === '') problems.push(`${where}: missing id`);
    checkDated(entry, where);
    a11y.push(entry);
  }

  if (problems.length > 0) {
    console.error('quarantine list rejected:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }
  const today = new Date().toISOString().slice(0, 10);
  return { byId, a11y, today, max };
}

/** Whether a failure of `id` is shielded right now, and why it is or is not. */
export function quarantineStatus(quarantine, id) {
  const entry = quarantine.byId.get(id);
  if (!entry) return { shielded: false };
  if (entry.expires <= quarantine.today) {
    return { shielded: false, expired: true, entry };
  }
  return { shielded: true, entry };
}

/** The live a11y entry covering this story/rule pair, if there is one. */
export function a11yShield(quarantine, storyId, rule) {
  return quarantine.a11y.find(
    (e) => e.rule === rule && (e.id === '*' || e.id === storyId) && e.expires > quarantine.today,
  );
}
