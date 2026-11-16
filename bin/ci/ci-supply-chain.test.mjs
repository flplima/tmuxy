import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpinned, workflowFiles } from './workflow-pins.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const SHA = 'a'.repeat(40);

describe('every action and install a workflow runs is pinned', () => {
  it('holds for every workflow and composite action in the repository', () => {
    const problems = workflowFiles(ROOT).flatMap((file) =>
      unpinned(read(file)).map(([line, problem]) => `${file}:${line}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });

  it('flags a tag, a branch and an unversioned cargo install, and passes a sha and a locked version', () => {
    const flagged = unpinned(
      [
        '      - uses: swatinem/rust-cache@v2',
        '      - uses: dtolnay/rust-toolchain@stable',
        '        run: cargo install tauri-webdriver',
        '        run: cargo install tauri-webdriver --version 0.2.0',
      ].join('\n'),
    ).map(([line]) => line);
    expect(flagged).toEqual([1, 2, 3, 4]);

    expect(
      unpinned(
        [
          `      - uses: actions/checkout@${SHA} # v7`,
          '      - uses: ./.github/actions/install-tmux',
          '      # `cargo install x` in a comment is prose',
          '        run: cargo install tauri-webdriver --version 0.2.0 --locked',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('the release build keeps its credentials to the steps that sign', () => {
  const workflow = read('.github/workflows/build-app.yml');
  const job = workflow.slice(
    workflow.indexOf('\n  build:\n'),
    workflow.indexOf('\n  upgrade-path:\n'),
  );
  // A step of the job starts at a six-space `- `.
  const [header, ...steps] = job.split(/\n(?= {6}- )/);
  const name = (step) => /name: (.+)/.exec(step)?.[1] ?? step.split('\n')[0].trim();
  const handsOut = (text) => /secrets\.APPLE_\w+\s*(?:\|\||\}\})/.test(text);

  it('grants a read-only token unless a job asks for more', () => {
    expect(workflow).toMatch(/^permissions:\n(?:#.*\n)*\s+contents: read$/m);
  });

  it('puts no signing secret on the job, only on the steps that stage, sign and notarize', () => {
    expect(handsOut(header)).toBe(false);
    expect(steps.filter(handsOut).map(name)).toEqual([
      'Stage the notarization key (macOS)',
      'Build Tauri app',
      'Notarize and staple the DMG itself (macOS)',
    ]);
  });

  it('deletes the notarization key after notarizing and before installing the smoke-test driver', () => {
    const at = (title) => steps.findIndex((step) => name(step) === title);
    const deleted = at('Delete the notarization key (macOS)');
    expect(deleted).toBeGreaterThan(at('Notarize and staple the DMG itself (macOS)'));
    expect(deleted).toBeLessThan(at('Install smoke test deps (macOS)'));
    expect(steps[deleted]).toMatch(/if: always\(\)/);
    expect(steps[deleted]).toContain('rm -rf "$HOME/private_keys"');
  });
});

describe('Dependabot action bumps', () => {
  it('wait a week, and come apart into GitHub-owned and third-party PRs', () => {
    const actions = read('.github/dependabot.yml').split('package-ecosystem: github-actions')[1];
    expect(actions).toMatch(/cooldown:\n\s+default-days: 7/);
    expect(actions).toMatch(/patterns: \["actions\/\*"\]/);
    expect(actions).toMatch(/exclude-patterns: \["actions\/\*"\]/);
  });
});

describe('the Claude review workflow runs on a trusted comment only', () => {
  const workflow = read('.github/workflows/claude-review.yml');

  it('starts only when flplima or laika-assistant comments `@claude review`', () => {
    expect(workflow).not.toMatch(/^ {2}pull_request:/m);
    expect(workflow).not.toMatch(/^ {2}pull_request_target:/m);
    expect(workflow).toContain(
      `contains(fromJSON('["flplima", "laika-assistant"]'), github.actor) &&`,
    );
    expect(workflow).toContain("trigger_phrase: '@claude review'");
    expect(workflow).not.toContain('allowed_bots:');
    expect(workflow).not.toContain('allowed_non_write_users:');
    expect(workflow).not.toContain('restrict_untrusted_prs:');
  });

  it('hands the subscription token to the API proxy only, never to Claude', () => {
    expect(workflow).toMatch(/^permissions:\n\s+contents: read$/m);
    expect(workflow).toContain(
      'uses: anthropics/claude-code-action@f3b070c88125d33dbae5653df5f143101d4ea9dc # v1',
    );
    expect(workflow).toContain('claude_code_oauth_token: held-by-the-proxy');
    expect(workflow.match(/secrets\.CLAUDE_CODE_OAUTH_TOKEN/g)).toHaveLength(1);
    expect(workflow).toContain('CLAUDE_REVIEW_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}');
    expect(workflow).toContain("classify_inline_comments: 'false'");
    expect(workflow).not.toContain('anthropic_api_key:');
    expect(workflow).not.toContain('anthropic_federation_rule_id:');
  });

  it('runs Sonnet, resolves PR stacks, and boots all live QA surfaces', () => {
    expect(workflow).toContain('--model sonnet');
    expect(workflow).toContain('--max-turns 60');
    expect(workflow).toContain('Agent,Task');
    expect(workflow).toContain('/tmp/pr-stack.md');
    expect(workflow).toContain('--trace /tmp/tmuxy-qa-trace.ndjson');
    expect(workflow).toContain('agent-browser --session qa-web');
    expect(workflow).toContain('agent-browser --session qa-sb');
    expect(workflow).toContain('tauri-driver --port 4444');
  });

  it('fences Claude and every QA surface from a script on the default branch', () => {
    expect(workflow).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(workflow).toContain(
      'cp bin/ci/claude-sandbox bin/ci/claude-api-proxy.mjs "$RUNNER_TEMP/trusted/"',
    );
    expect(workflow).toMatch(
      /"\$SANDBOX" setup\n\s+"\$SANDBOX" proxy\n\s+"\$SANDBOX" lock\n\s+"\$SANDBOX" check/,
    );
    expect(workflow).toContain(
      'path_to_claude_code_executable: ${{ runner.temp }}/trusted/claude-launch',
    );
    for (const launch of [
      '"$SANDBOX" run env RUST_LOG=',
      '"$SANDBOX" run npm run storybook',
      '"$SANDBOX" run tauri-driver',
      '"$SANDBOX" run ./target/debug/tmuxy 2>',
    ]) {
      expect(workflow).toContain(launch);
    }
    expect(workflow).not.toMatch(
      /^\s+(?:\.\/target\/debug\/tmuxy 2>|tauri-driver --port|npm run storybook)/m,
    );
    expect(workflow).not.toMatch(/mcp__github/);
    expect(workflow).not.toMatch(/^\s+GH_TOKEN:.*\n(?:.*\n){0,3}\s+uses: anthropics/m);
  });

  it('posts from a job that never holds the Claude token and never runs the PR', () => {
    const [review, publish] = workflow.split('\n  publish:\n');
    expect(review).toMatch(/permissions:\n\s+contents: read\n\s+pull-requests: read\n/);
    expect(publish).toBeDefined();
    expect(publish).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(publish).not.toContain('pr-stack');
    expect(publish).toContain('persist-credentials: false');
    expect(publish).toContain('bin/ci/claude-review-publish');
  });

  it('fences the agent: own user, no DNS, loopback and the Claude API, checked before Claude starts', () => {
    const sandbox = read('bin/ci/claude-sandbox');
    expect(sandbox).toContain('--uid-owner');
    expect(sandbox).toMatch(/--dport 53 -j REJECT/);
    expect(sandbox).toContain('-o lo -j ACCEPT');
    expect(sandbox).toMatch(
      /-A CLAUDE_AGENT -o lo -j ACCEPT\n\s+sudo "\$ipt" -A CLAUDE_AGENT -j REJECT/,
    );
    expect(sandbox).not.toMatch(/--preserve-env=[^\n]*TOKEN/);
    expect(sandbox).toContain('ANTHROPIC_AUTH_TOKEN=held-by-the-proxy');
    for (const fence of [
      'no web',
      'no Claude API but through the proxy',
      'no GitHub',
      'no DNS',
      'no sudo',
      'no docker',
    ]) {
      expect(sandbox).toContain(`expect_fail "${fence}"`);
    }
    expect(sandbox).toContain('"WebFetch"');
    expect(sandbox).toContain('"Read(//proc/**)"');
    expect(sandbox).toContain('"CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1"');
  });

  it('withholds a review that carries anything shaped like an Anthropic token', () => {
    const publish = read('bin/ci/claude-review-publish');
    expect(publish).toContain("grep -rqaiE 'sk-ant-[a-z0-9_-]{8}'");
  });
});
