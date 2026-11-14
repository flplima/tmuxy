const fs = require('fs');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');
const { SOCKET } = require('./helpers/env');

describe('CLI info and skill commands', () => {
  describe('tmuxy info', () => {
    test('shows multiplexer status (plain text outside session)', () => {
      const { stdout, exitCode } = runCLI(['info']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('tmuxy');
      expect(stdout).toContain('Status:');
      expect(stdout).toContain('Agent Guide:');
      expect(stdout).toContain('tmuxy skill');
    });

    test('shows status inside session with mock info', () => {
      const { stdout, exitCode } = runCLI(['info'], {
        env: {
          TMUX: '/tmp/tmuxy,123,0',
          MOCK_TMUX_INFO: 'my-session\t%42\t@3\t100\t30\tbash\t1\twork\t2\n',
        },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`socket: ${SOCKET}, session: my-session`);
      expect(stdout).toContain('Pane:    %42');
      expect(stdout).toContain('Tab:     @3');
      expect(stdout).toContain('Agent Guide:');
      expect(stdout).toContain('tmuxy skill');
    });

    test('tmuxy info --json outputs structured JSON', () => {
      const { stdout, exitCode } = runCLI(['info', '--json'], {
        env: {
          TMUX: '/tmp/tmuxy,123,0',
          MOCK_TMUX_INFO: 'my-session\t%42\t@3\t100\t30\tbash\t1\twork\t2\n',
        },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toMatchObject({
        inside: true,
        socket: SOCKET,
        session: 'my-session',
        activePane: { id: '%42', width: 100, height: 30, command: 'bash' },
        activeTab: { id: '@3', index: 1, name: 'work', panesCount: 2 },
      });
      expect(parsed.agentSkillHint).toContain('tmuxy skill');
    });

    test('tmuxy info --json escapes quotes and backslashes in session and tab names', () => {
      const { stdout, exitCode } = runCLI(['info', '--json'], {
        env: {
          TMUX: '/tmp/tmuxy,123,0',
          MOCK_TMUX_INFO: 'sess"a\\\\b\t%42\t@3\t100\t30\tba"sh\t1\twork"tab\\\\1\t2\n',
        },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.session).toBe('sess"a\\b');
      expect(parsed.activePane.command).toBe('ba"sh');
      expect(parsed.activeTab.name).toBe('work"tab\\1');
    });

    test('tmuxy --json outputs structured JSON at root', () => {
      const { stdout, exitCode } = runCLI(['--json'], {
        env: {
          TMUX: '/tmp/tmuxy,123,0',
          MOCK_TMUX_INFO: 'my-session\t%42\t@3\t100\t30\tbash\t1\twork\t2\n',
        },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toMatchObject({
        inside: true,
        socket: SOCKET,
        session: 'my-session',
        activePane: { id: '%42' },
      });
    });
  });

  describe('tmuxy skill', () => {
    // The guide is the server binary's, which embeds .agents/skills/tmuxy/SKILL.md.
    test('prints the agent guide the server binary embeds', () => {
      const { stdout, exitCode } = runCLI(['skill']);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('mock-server-started skill');
    });

    test('skill --help prints usage', () => {
      const { stdout, exitCode } = runCLI(['skill', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy skill');
    });
  });

  describe('tmuxy version and agent notes', () => {
    test('tmuxy --version prints version string', () => {
      const { stdout, exitCode } = runCLI(['--version']);
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/^tmuxy \d+\.\d+\.\d+/);
    });

    // A checkout's CLI reads the tree's package.json; the copy the app
    // mirrors has the binary's version written in (tmuxy-core session tests).
    test("a checkout's CLI prints package.json's version", () => {
      const root = path.resolve(__dirname, '../..');
      const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      expect(runCLI(['--version']).stdout.trim()).toBe(`tmuxy ${version}`);
    });

    test('top-level help includes AI agent note', () => {
      const { stdout, exitCode } = runCLI(['--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Note for AI/LLM agents:');
      expect(stdout).toContain('tmuxy skill');
      expect(stdout).toContain('--json');
    });

    test('unknown command prints actionable hint for agents', () => {
      const { stderr, exitCode } = runCLI(['badcommand']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('Unknown command: badcommand');
      expect(stderr).toContain("Hint: run 'tmuxy --help' for available commands, or 'tmuxy skill'");
    });
  });
});
