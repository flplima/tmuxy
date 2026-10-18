/**
 * A browser started the way anyone starts one for remote debugging: headless,
 * a profile of its own and a kernel-chosen port, announced in the profile's
 * DevToolsActivePort. What `tmuxy browser --attach` is pointed at.
 */

const { spawn } = require('child_process');

/** Start `engine` on `profile`; returns the process, for the caller to kill. */
function startDebuggableBrowser(engine, profile) {
  return spawn(
    engine,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}

module.exports = { startDebuggableBrowser };
