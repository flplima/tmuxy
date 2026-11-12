/**
 * Replay a trace against the suite's server: the ops the app ran, in order,
 * rebuilt from the trace's `store` lines as the CLI commands that do the
 * same, through the user's own way in (`machines/actors/tmuxStoreActor.ts`
 * writes one per op: its name, pane, window and direction). It is how a
 * maintainer turns a bug report's trace into a reproduction.
 *
 * A trace holds no content, so an op that needs more than ids and a
 * direction (a resize's size, a rename's text, keys typed into a pane) is
 * not rebuilt: it is reported as skipped, and the replay goes on. Pane and
 * window ids in the trace are mapped to live ones by first appearance: the
 * first trace pane named is the live session's first pane, the next new one
 * the next live pane tmux made, and so on. A redacted trace replays the same
 * way, since redaction keeps ids and ops.
 */

const { waitForSettled } = require('./browser');
const { tmuxyCli } = require('./cli');

/** The `store` lines of an NDJSON trace, in order. */
function storeActions(text) {
  return text
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((ev) => ev && ev.layer === 'store' && typeof ev.name === 'string')
    .map(({ name, pane, window, kind }) => ({ name, pane, window, kind }));
}

/**
 * The CLI command that does what an action did, with ids mapped through
 * `id`: `{ args, pane }`, `pane` being the pane to run it as from (the
 * verbs that act on their caller's pane); null when it cannot be rebuilt.
 */
function rebuildCommand(action, id) {
  const pane = action.pane ? id(action.pane) : null;
  const window = action.window ? id(action.window) : null;
  switch (action.name) {
    case 'Split':
      // The app's horizontal split is a pane below.
      return ['horizontal', 'vertical'].includes(action.kind)
        ? { args: ['pane', 'split', action.kind === 'horizontal' ? '-v' : '-h'], pane: null }
        : null;
    case 'SelectPane':
      return pane ? { args: ['pane', 'select', pane], pane: null } : null;
    case 'KillPane':
      return pane ? { args: ['pane', 'kill', pane], pane: null } : null;
    case 'ZoomToggle':
      return pane ? { args: ['pane', 'zoom'], pane } : null;
    case 'BreakPane':
      return pane ? { args: ['pane', 'break'], pane } : null;
    case 'CyclePane':
      return { args: ['nav', 'next'], pane: null };
    case 'NewWindow':
      return { args: ['tab', 'create'], pane: null };
    case 'SelectWindow':
      return window ? { args: ['tab', 'select', window], pane: null } : null;
    case 'KillWindow':
      return window ? { args: ['tab', 'kill', window], pane: null } : null;
    default:
      return null;
  }
}

/** The test session's live pane and window ids, oldest first. */
function liveIds(session) {
  const rows = session
    .runCommand(`list-panes -s -t ${session.name} -F '#{pane_id} #{window_id}'`)
    .split('\n')
    .map((row) => row.trim().split(' '))
    .filter((row) => row.length === 2);
  const number = (id) => Number(id.slice(1));
  const ids = (at) =>
    [...new Set(rows.map((row) => row[at]))].sort((a, b) => number(a) - number(b));
  return { panes: ids(0), windows: ids(1) };
}

/**
 * Replay `text` (an NDJSON trace) in `page`'s app, whose tmux session is
 * `session` (the suite's `ctx.session`). Resolves to what was replayed and
 * what was skipped, by op name, in order, and how the ids were mapped.
 */
async function replayTrace(page, session, text) {
  const mapped = new Map();
  const id = (traceId) => {
    if (mapped.has(traceId)) return mapped.get(traceId);
    const live = liveIds(session);
    const pool = traceId.startsWith('@') ? live.windows : live.panes;
    const taken = new Set(mapped.values());
    const next = pool.find((candidate) => !taken.has(candidate)) ?? null;
    if (next) mapped.set(traceId, next);
    return next;
  };
  const replayed = [];
  const skipped = [];
  for (const action of storeActions(text)) {
    const command = rebuildCommand(action, id);
    if (!command) {
      skipped.push(action.name);
      continue;
    }
    // Run as from the pane the action was about, else the session's active one.
    const from =
      command.pane ??
      session.runCommand(`display-message -p -t ${session.name} '#{pane_id}'`).trim();
    tmuxyCli(command.args, { TMUX_PANE: from });
    await waitForSettled(page);
    replayed.push(action.name);
  }
  return { replayed, skipped, ids: Object.fromEntries(mapped) };
}

module.exports = { storeActions, replayTrace };
