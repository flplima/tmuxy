#!/usr/bin/env node
/**
 * The environment of the server under test, as shell lines:
 *
 *   eval "$(node tests/helpers/server-env.js)"
 *
 * For a workflow that starts the server itself rather than letting
 * jest.setup.js do it. The server has to see the same config, data and state
 * dirs as the helpers (`tmuxEnv()`): a plugin a test installs into the suite's
 * config dir is otherwise one the server never heard of.
 */

const { tmuxEnv } = require('./tmux-socket');

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const pinned = tmuxEnv();
const lines = [];
for (const [name, value] of Object.entries(pinned)) {
  if (process.env[name] !== value) lines.push(`export ${name}=${quote(value)}`);
}
for (const name of Object.keys(process.env)) {
  if (!(name in pinned)) lines.push(`unset ${name}`);
}
process.stdout.write(lines.join('\n') + '\n');
