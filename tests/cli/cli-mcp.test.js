const { runCLI } = require('./helpers/run-cli');

/**
 * `tmuxy mcp` prints where an MCP client reaches the session. The URL it
 * prints is the whole setup: a wrong session or a lost `read-only` there is
 * an agent driving the wrong session, or with hands it was not to have.
 */
describe('tmuxy mcp', () => {
  test('names the session the caller is in, and keeps read-only in the URL', () => {
    const { stdout, exitCode } = runCLI(['mcp', '--json', '--read-only', '--port', '9137'], {
      env: {
        TMUX_SOCKET: 'tmuxy',
        TMUX: '/tmp/tmuxy,123,0',
        TMUX_PANE: '%4',
        MOCK_TMUX_SESSION: 'work',
      },
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      url: 'http://127.0.0.1:9137/mcp?session=work&read-only',
      session: 'work',
      readOnly: true,
    });
  });

  test('prints the plain endpoint and the command that adds it to Claude Code', () => {
    const { stdout, exitCode } = runCLI(['mcp'], { env: { TMUX: '' } });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('  http://127.0.0.1:9000/mcp\n');
    expect(stdout).toContain("claude mcp add --transport http tmuxy 'http://127.0.0.1:9000/mcp'");
    // The password stays a variable the user's shell expands, never a value.
    expect(stdout).toContain('"$TMUXY_PASSWORD"');
  });

  test('refuses what it would splice into the URL unchecked', () => {
    for (const args of [
      ['--port', '90a0'],
      ['--host', 'a b'],
      ['--session', 'x&read-only=0'],
      ['--frobnicate'],
    ]) {
      const { exitCode } = runCLI(['mcp', ...args], { env: { TMUX: '' } });
      expect(exitCode).toBe(2);
    }
  });
});
