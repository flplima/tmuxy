/**
 * A perf run splits, types into and closes tabs: it is only ever pointed at
 * a server made for it. This refuses any other, before it touches anything.
 *
 * What tells them apart is the tmux socket the server drives. People work in
 * `tmuxy` (the app) and `tmuxy-dev` (the dev server); the E2E and CI servers
 * use `tmuxy-test` and a perf run its own `tmuxy-perf` (a `-suffix` allowed:
 * `tmuxy-perf-busy`). Anything else is refused, `tmuxy-testing` and the
 * user's own tmux (`default`) included.
 */

/** The socket names a perf run may drive. */
const THROWAWAY = /^tmuxy-(perf|test)(-[A-Za-z0-9_.]+)*$/;

/** `--url`, required: a perf run has no default server to fall back to. */
export function requiredUrl(argv) {
  const i = argv.indexOf('--url');
  const url = i === -1 ? null : argv[i + 1];
  if (!url) {
    throw new Error(
      '--url is required: point it at a throwaway server (a socket named tmuxy-test… or tmuxy-perf…), never the one you work in',
    );
  }
  return url;
}

/**
 * Refuse unless the server behind `page` (connected, so its session exists)
 * drives a throwaway socket. `evaluate` runs a function in the page.
 */
export async function assertThrowawayServer(evaluate) {
  const socket = await evaluate(async () => {
    const session = new URLSearchParams(location.search).get('session') ?? 'tmuxy';
    const response = await fetch(`/commands?session=${encodeURIComponent(session)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'query_tmux',
        args: { command: "display-message -p '#{socket_path}'" },
      }),
    });
    // The server answers `{ result }`, as the app's own transport reads it.
    return response.ok ? String((await response.json()).result ?? '') : null;
  });
  const name = (socket ?? '').trim().split('/').pop();
  if (!name || !THROWAWAY.test(name)) {
    throw new Error(
      `refusing to run against a tmux socket named ${JSON.stringify(name || 'unknown')}: ` +
        'a perf run splits and closes tabs, so it only drives a throwaway server (tmuxy-test… or tmuxy-perf…)',
    );
  }
}
