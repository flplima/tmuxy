const fs = require('fs');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');

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
          TMUX_SOCKET: 'tmuxy',
          TMUX: '/tmp/tmuxy,123,0',
          MOCK_TMUX_INFO: 'my-session\t%42\t@3\t100\t30\tbash\t1\twork\t2\n',
        },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('socket: tmuxy, session: my-session');
      expect(stdout).toContain('Pane:    %42');
      expect(stdout).toContain('Tab:     @3');
      expect(stdout).toContain('Agent Guide:');
      expect(stdout).toContain('tmuxy skill');
    });

    test('tmuxy info --json outputs structured JSON', () => {
      const { stdout, exitCode } = runCLI(['info', '--json'], {
        env: {
          TMUX_SOCKET: 'tmuxy',
          TMUX: '/tmp/tmuxy,123,0',
          MOCK_TMUX_INFO: 'my-session\t%42\t@3\t100\t30\tbash\t1\twork\t2\n',
        },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toMatchObject({
        inside: true,
        socket: 'tmuxy',
        session: 'my-session',
        activePane: { id: '%42', width: 100, height: 30, command: 'bash' },
        activeTab: { id: '@3', index: 1, name: 'work', panesCount: 2 },
      });
      expect(parsed.agentSkillHint).toContain('tmuxy skill');
    });

    test('tmuxy --json outputs structured JSON at root', () => {
      const { stdout, exitCode } = runCLI(['--json'], {
        env: {
          TMUX_SOCKET: 'tmuxy',
          TMUX: '/tmp/tmuxy,123,0',
          MOCK_TMUX_INFO: 'my-session\t%42\t@3\t100\t30\tbash\t1\twork\t2\n',
        },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toMatchObject({
        inside: true,
        socket: 'tmuxy',
        session: 'my-session',
        activePane: { id: '%42' },
      });
    });
  });

  describe('tmuxy skill', () => {
    test('outputs canonical agent skill markdown', () => {
      const { stdout, exitCode } = runCLI(['skill']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('# tmuxy');
      expect(stdout).toContain('Never run a mutating raw `tmux` command');
      expect(stdout).toContain('CLI cheat sheet');
      expect(stdout).toContain('tmuxy pane split');
    });

    test('the repo skill file is the guide the CLI prints, verbatim', () => {
      // `tmuxy skill` is the source: an installed CLI has no repo to read the
      // skill file from. Regenerate with `bin/tmuxy-cli skill > .agents/skills/tmuxy/SKILL.md`.
      const { stdout } = runCLI(['skill']);
      const skill = fs.readFileSync(
        path.resolve(__dirname, '../../.agents/skills/tmuxy/SKILL.md'),
        'utf8',
      );
      expect(skill).toBe(stdout);
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

    test('the fallback version for an install without package.json is the current one', () => {
      // bump-version (.agents/skills/release/scripts) rewrites this line with
      // every release; a bump that missed it would ship a stale --version.
      const root = path.resolve(__dirname, '../..');
      const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const cli = fs.readFileSync(path.join(root, 'bin/tmuxy-cli'), 'utf8');
      expect(cli).toContain(`TMUXY_VERSION="\${TMUXY_VERSION:-${version}}"`);
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
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown command: badcommand');
      expect(stderr).toContain("Hint: run 'tmuxy --help' for available commands, or 'tmuxy skill'");
    });
  });
});
