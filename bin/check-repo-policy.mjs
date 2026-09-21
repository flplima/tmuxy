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
      addError('[workflow] lint-and-tests.yml concurrency.group drifted from the canonical PR/run_id policy.');
    }
    if (!/cancel-in-progress:\s*true/.test(lintAndTests.content)) {
      addError('[workflow] lint-and-tests.yml must set concurrency.cancel-in-progress: true.');
    }
  }

  for (const wf of workflows) {
    if (wf.name === 'copilot-setup-steps.yml') {
      if (!/copilot-setup-steps:[\s\S]*?permissions:\n\s+contents:\s+read/m.test(wf.content)) {
        addError('[workflow] copilot-setup-steps.yml must keep contents: read permissions on the copilot-setup-steps job.');
      }
    } else if (!/^permissions:\n\s+contents:\s+/m.test(wf.content)) {
      addError(`[workflow] ${wf.name} must define top-level contents permissions.`);
    }

    const keyLines = wf.content.match(/^[ \t]*key:\s*.+$/gm) || [];
    for (const keyLine of keyLines) {
      if (!keyLine.includes('runner.os') && !keyLine.includes('matrix.os')) {
        addError(`[workflow] ${wf.name} cache key must include runner/matrix OS namespace: ${keyLine.trim()}`);
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
      if (!/^(?:\.github|docs|bin|packages|tests|Cargo\.lock|package\.json|AGENTS\.md|CLAUDE\.md|\.agents|\.claude)\//.test(token) && !['AGENTS.md', 'CLAUDE.md', 'Cargo.lock', 'package.json'].includes(token)) {
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
  const copilotInstructions = fs.readFileSync(path.join(root, '.github/copilot-instructions.md'), 'utf8');
  const canonicalTargets = [agentsContent, copilotInstructions].join('\n');

  for (const command of requiredCanonicalCommands) {
    if (!canonicalTargets.includes(command)) {
      addError(`[docs] Missing canonical command in AGENTS/Copilot instructions: ${command}`);
    }
  }

  for (const docPath of wrapperStrictDocs) {
    const content = fs.readFileSync(path.join(root, docPath), 'utf8');
    if (/npm run (?:agent|copilot):/.test(content)) {
      addError(`[docs] ${docPath} should use the canonical commands (bootstrap/check:*), not agent/copilot aliases.`);
    }
  }
}

checkControlModeEnforcement();
checkWorkflowInvariants();
checkDocsToScriptsConsistency();

if (errors.length > 0) {
  console.error('Repo policy checks failed:\n');
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

console.log('Repo policy checks passed.');
