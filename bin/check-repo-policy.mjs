#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const errors = [];

function listFiles(dir, exts, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, exts, acc);
      continue;
    }
    if (exts.has(path.extname(entry.name))) acc.push(full);
  }
  return acc;
}

function rel(p) {
  return path.relative(root, p).replaceAll('\\', '/');
}

function addError(message) {
  errors.push(message);
}

function findLine(content, index) {
  return content.slice(0, index).split('\n').length;
}

function checkControlModeEnforcement() {
  const protectedDirs = [
    'packages/tmuxy-ui/src',
    'packages/tmuxy-server/src',
    'packages/tmuxy-tauri-app/src',
  ];
  const exts = new Set(['.rs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const patterns = [
    {
      name: 'rust Command::new("tmux")',
      re: /(?:std::process::|tokio::process::|pty_process::)?Command::new\(\s*"tmux"\s*\)/g,
    },
    {
      name: 'shell subprocess tmux call',
      re: /\b(?:spawn|exec|execFile|fork)\s*\([^\n]*["'`]tmux["'`]/g,
    },
  ];

  for (const dir of protectedDirs) {
    const abs = path.join(root, dir);
    const files = listFiles(abs, exts);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const { name, re } of patterns) {
        let match;
        while ((match = re.exec(content)) !== null) {
          const line = findLine(content, match.index);
          addError(
            `[control-mode] Forbidden ${name} in ${rel(file)}:${line}. Route tmux via control-mode adapters/router.`,
          );
        }
        re.lastIndex = 0;
      }
    }
  }
}

function checkWorkflowInvariants() {
  const workflowsDir = path.join(root, '.github/workflows');
  const workflows = fs
    .readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => ({
      name,
      full: path.join(workflowsDir, name),
      content: fs.readFileSync(path.join(workflowsDir, name), 'utf8'),
    }));

  const lintAndTests = workflows.find((w) => w.name === 'lint-and-tests.yml');
  if (!lintAndTests) {
    addError('[workflow] Missing .github/workflows/lint-and-tests.yml');
  } else {
    if (!/^concurrency:\n/m.test(lintAndTests.content)) {
      addError('[workflow] lint-and-tests.yml must define top-level concurrency.');
    }
    const expectedGroup =
      "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.head_ref || github.run_id }}";
    if (!lintAndTests.content.includes(expectedGroup)) {
      addError(
        '[workflow] lint-and-tests.yml concurrency.group drifted from the canonical PR/run_id policy.',
      );
    }
    if (!/cancel-in-progress:\s*true/.test(lintAndTests.content)) {
      addError('[workflow] lint-and-tests.yml must set concurrency.cancel-in-progress: true.');
    }
  }

  for (const wf of workflows) {
    if (wf.name === 'copilot-setup-steps.yml') {
      if (!/copilot-setup-steps:[\s\S]*?permissions:\n\s+contents:\s+read/m.test(wf.content)) {
        addError(
          '[workflow] copilot-setup-steps.yml must keep contents: read permissions on the copilot-setup-steps job.',
        );
      }
    } else if (!/^permissions:\n\s+contents:\s+/m.test(wf.content)) {
      addError(`[workflow] ${wf.name} must define top-level contents permissions.`);
    }

    const keyLines = wf.content.match(/^[ \t]*key:\s*.+$/gm) || [];
    for (const keyLine of keyLines) {
      if (!keyLine.includes('runner.os') && !keyLine.includes('matrix.os')) {
        addError(
          `[workflow] ${wf.name} cache key must include runner/matrix OS namespace: ${keyLine.trim()}`,
        );
      }
    }
  }
}

function checkDocsToScriptsConsistency() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const scripts = new Set(Object.keys(packageJson.scripts || {}));

  for (const workspace of packageJson.workspaces || []) {
    const pkgPath = path.join(root, workspace, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    for (const name of Object.keys(pkg.scripts || {})) scripts.add(name);
  }

  const commandDocs = [
    'AGENTS.md',
    '.github/copilot-instructions.md',
    'docs/RUNBOOK.md',
    'docs/CI-TRIAGE.md',
  ];

  const requiredCanonicalCommands = [
    'bash bin/bootstrap',
    'npm run check:fast',
    'npm run check:full',
  ];

  const wrapperStrictDocs = ['AGENTS.md', '.github/copilot-instructions.md'];

  for (const docPath of commandDocs) {
    const full = path.join(root, docPath);
    const content = fs.readFileSync(full, 'utf8');

    for (const match of content.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
      const scriptName = match[1];
      if (!scripts.has(scriptName)) {
        addError(`[docs] ${docPath} references missing npm script: ${scriptName}`);
      }
    }

    const inlineCode = content.match(/`[^`]+`/g) || [];
    for (const tokenRaw of inlineCode) {
      const token = tokenRaw.slice(1, -1).trim();
      if (!token.includes('/')) continue;
      if (token.includes(' ')) continue;
      if (token.includes('*') || token.includes('..') || token.includes('://')) continue;
      if (
        !/^(?:\.github|docs|bin|packages|tests|Cargo\.lock|package\.json|AGENTS\.md|CLAUDE\.md|\.agents|\.claude)\//.test(
          token,
        ) &&
        !['AGENTS.md', 'CLAUDE.md', 'Cargo.lock', 'package.json'].includes(token)
      ) {
        continue;
      }
      const cleaned = token.replace(/[),.:;]+$/, '');
      const candidate = path.join(root, cleaned);
      const generatedPath = /\/(?:dist|pkg)(?:\/|$)/.test(cleaned);
      if (!generatedPath && !fs.existsSync(candidate)) {
        addError(`[docs] ${docPath} references missing path: ${cleaned}`);
      }
    }
  }

  const agentsContent = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const copilotInstructions = fs.readFileSync(
    path.join(root, '.github/copilot-instructions.md'),
    'utf8',
  );
  const canonicalTargets = [agentsContent, copilotInstructions].join('\n');

  for (const command of requiredCanonicalCommands) {
    if (!canonicalTargets.includes(command)) {
      addError(`[docs] Missing canonical command in AGENTS/Copilot instructions: ${command}`);
    }
  }

  for (const docPath of wrapperStrictDocs) {
    const content = fs.readFileSync(path.join(root, docPath), 'utf8');
    if (/npm run (?:agent|copilot):/.test(content)) {
      addError(
        `[docs] ${docPath} should use the canonical commands (bootstrap/check:*), not agent/copilot aliases.`,
      );
    }
  }
}

/**
 * A ratchet on blind waits in the test suite.
 *
 * `delay(n)` sleeps for a number someone measured on their own laptop. A CI
 * runner is slower, so the wait that was generous here is short there, and the
 * test fails for a reason it cannot report — the whole class of flake that
 * "it passed locally" cannot rule out. `waitForCondition` has no such failure
 * mode: a condition that holds is observed the moment it holds, and one that
 * never holds fails with a description.
 *
 * Converting all of them at once is not realistic, so the count is pinned
 * instead. The ceiling may only be lowered — when a conversion lands, drop the
 * number in the same commit. It is not a budget to spend; a new test that
 * needs a wait uses `waitForCondition`, which this check does not count.
 *
 * `delay()` remains legitimate in two places and is not counted: inside
 * `waitForCondition`'s own poll loop, and as a sub-100ms beat between the parts
 * of one input gesture (keyboard.down → press → up), where there is no
 * observable state between the halves to wait on.
 */
const BLIND_WAIT_CEILING = {
  // Shared machinery. A blind wait here is multiplied by every test that calls
  // the helper, so this is the number that matters most.
  'tests/helpers': 49,
  // Test bodies. Each one affects a single test.
  tests: 209,
};

function countBlindWaits(content) {
  // `await delay(...)` and bare `delay(...)` calls, but not the identifier
  // appearing in a comment, an import, or a property name.
  const matches = content.match(/(?<![\w.])delay\s*\(/g) ?? [];
  return matches.length;
}

function checkBlindWaitRatchet() {
  const counts = { 'tests/helpers': 0, tests: 0 };
  const helperDir = path.join(root, 'tests/helpers');

  for (const file of listFiles(path.join(root, 'tests'), new Set(['.js']))) {
    const relative = rel(file);
    // The definition and the poll loop live here; counting them would pin a
    // number that has nothing to do with blind waiting.
    if (relative === 'tests/helpers/browser.js') continue;
    const bucket = file.startsWith(helperDir) ? 'tests/helpers' : 'tests';
    counts[bucket] += countBlindWaits(fs.readFileSync(file, 'utf8'));
  }

  for (const [bucket, ceiling] of Object.entries(BLIND_WAIT_CEILING)) {
    const count = counts[bucket];
    if (count > ceiling) {
      addError(
        `[tests] ${count} blind delay() calls in ${bucket}/ exceeds the ceiling of ${ceiling}. ` +
          'Use waitForCondition(page, fn, budget, description) instead — see ' +
          'BLIND_WAIT_CEILING in bin/check-repo-policy.mjs.',
      );
    } else if (count < ceiling) {
      addError(
        `[tests] ${count} blind delay() calls in ${bucket}/ is below the ceiling of ${ceiling}. ` +
          `Lower BLIND_WAIT_CEILING['${bucket}'] to ${count} in bin/check-repo-policy.mjs so the ` +
          'ratchet holds the ground this commit just gained.',
      );
    }
  }
}

checkControlModeEnforcement();
checkWorkflowInvariants();
checkDocsToScriptsConsistency();
checkBlindWaitRatchet();

if (errors.length > 0) {
  console.error('Repo policy checks failed:\n');
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

console.log('Repo policy checks passed.');
