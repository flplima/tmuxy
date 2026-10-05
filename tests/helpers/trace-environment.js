/**
 * The E2E suites' Jest environment: the node one, plus a trace marker at the
 * start and end of every test.
 *
 * The server under test writes its action trace (docs/TELEMETRY.md) to
 * `TMUXY_E2E_TRACE`; a marker in that file says which test was running, so a
 * failure can be read as one test's slice instead of a whole run's. When a
 * test fails, the trace health check for that slice is printed with it —
 * which panes were silent, what reconnected, what was rejected — because the
 * test's own message only says what the test was waiting for.
 *
 * Without `TMUXY_E2E_TRACE` (or with no server binary to stamp it with) this
 * is the plain node environment.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const NodeEnvironment = require('jest-environment-node').TestEnvironment;
const { serverBinary } = require('./server-binary');

/** A test's name as the marker carries it: file › describe › test. */
function testLabel(testPath, test) {
  const names = [];
  for (let block = test; block && block.name !== 'ROOT_DESCRIBE_BLOCK'; block = block.parent) {
    names.unshift(block.name);
  }
  return `${path.basename(testPath)} › ${names.join(' › ')}`;
}

class TraceEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    this.testPath = context.testPath;
    this.trace = process.env.TMUXY_E2E_TRACE || null;
    this.binary = null;
    if (this.trace) {
      try {
        this.binary = serverBinary();
      } catch {
        this.trace = null;
      }
    }
  }

  /** Run the server binary's `trace` verb; never fails a test. */
  traceVerb(args) {
    if (!this.binary || !this.trace) return '';
    try {
      return execFileSync(this.binary, ['trace', ...args, this.trace], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  }

  async handleTestEvent(event) {
    if (!this.trace) return;
    if (event.name === 'test_start') {
      this.traceVerb(['--mark', `${testLabel(this.testPath, event.test)} › start`]);
    } else if (event.name === 'test_done') {
      const label = testLabel(this.testPath, event.test);
      const failed = event.test.errors.length > 0;
      this.traceVerb(['--mark', `${label} › ${failed ? 'fail' : 'pass'}`]);
      if (failed && fs.existsSync(this.trace)) {
        const slice = this.traceVerb(['--check', '--window', `${label} › start`]);
        if (slice) {
          process.stderr.write(`\n── trace of "${label}" (${this.trace}) ──\n${slice}\n`);
        }
      }
    }
  }
}

module.exports = TraceEnvironment;
