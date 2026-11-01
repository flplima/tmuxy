#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { checkFileTokenLimit } from './ci/file-token-limit.mjs';

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

    for (const keyLine of cacheKeyLines(wf.content)) {
      if (!namespacesByOs([keyLine])) {
        addError(
          `[workflow] ${wf.name} cache key must include runner/matrix OS namespace: ${keyLine.trim()}`,
        );
      }
    }
  }

  // The same rule for the composite actions the workflows share their cache
  // steps through. A key there may take its namespace from an input, in which
  // case the input's default is what has to name the OS.
  const actionsDir = path.join(root, '.github/actions');
  for (const entry of fs.readdirSync(actionsDir)) {
    const file = path.join(actionsDir, entry, 'action.yml');
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    const inputDefault = (name) =>
      content.match(new RegExp(`^  ${name}:\\n(?:    .*\\n)*?    default:\\s*(.+)$`, 'm'))?.[1] ??
      '';
    for (const keyLine of cacheKeyLines(content)) {
      const defaults = [...keyLine.matchAll(/inputs\.([\w-]+)/g)].map((m) => inputDefault(m[1]));
      if (!namespacesByOs([keyLine, ...defaults])) {
        addError(
          `[workflow] .github/actions/${entry} cache key must include runner/matrix OS namespace: ${keyLine.trim()}`,
        );
      }
    }
  }
}

function cacheKeyLines(content) {
  return content.match(/^[ \t]*key:\s*.+$/gm) || [];
}

function namespacesByOs(texts) {
  return texts.some((text) => text.includes('runner.os') || text.includes('matrix.os'));
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

  // Every doc, not a hand-kept four: a path a doc names is checked wherever
  // the doc is, so a renamed file is caught by the doc that still names it.
  const commandDocs = [
    'AGENTS.md',
    'CONTRIBUTING.md',
    'AI_POLICY.md',
    '.github/copilot-instructions.md',
    ...fs
      .readdirSync(path.join(root, 'docs'))
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => `docs/${name}`),
  ];

  const requiredCanonicalCommands = [
    'bash bin/bootstrap',
    'npm run check:fast',
    'npm run check:full',
  ];

  // A path a doc names may be one the build makes — a wasm `pkg`, a `dist`,
  // the probe's artifacts. Those exist on the machine that wrote the doc and
  // not in a fresh checkout, so existence is asked only of paths git tracks:
  // anything .gitignore lists is taken as generated.
  const ignored = fs
    .readFileSync(path.join(root, '.gitignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!') && !line.includes('*'))
    .map((line) => line.replace(/^\//, '').replace(/\/$/, ''));
  const gitignored = (rel) =>
    ignored.some((entry) =>
      entry.includes('/')
        ? rel === entry || rel.startsWith(`${entry}/`)
        : rel.split('/').includes(entry),
    );

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
        !/^(?:\.github|docs|bin|packages|tests|Cargo\.lock|package\.json|AGENTS\.md|\.agents)\//.test(
          token,
        ) &&
        !['AGENTS.md', 'Cargo.lock', 'package.json'].includes(token)
      ) {
        continue;
      }
      const cleaned = token.replace(/[),.:;]+$/, '');
      const candidate = path.join(root, cleaned);
      if (!gitignored(cleaned) && !fs.existsSync(candidate)) {
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
}

/**
 * A ratchet on blind waits in the test suite.
 *
 * A sleep — `delay(n)`, or a raw `await new Promise((r) => setTimeout(r, n))` —
 * waits for a number someone measured on their own laptop. A CI runner is
 * slower, so the wait that was generous here is short there, and the test
 * fails for a reason it cannot report — the whole class of flake that "it
 * passed locally" cannot rule out. `waitForCondition` has no such failure
 * mode: a condition that holds is observed the moment it holds, and one that
 * never holds fails with a description.
 *
 * Converting all of them at once is not realistic, so the count is pinned
 * instead. The ceiling may only be lowered — when a conversion lands, drop the
 * number in the same commit. It is not a budget to spend; a new test that
 * needs a wait uses `waitForCondition`, which this check does not count.
 *
 * A sleep is legitimate, and not counted, in two places: as the interval of a
 * poll loop (inside a `while`/`do` loop, a counted `for` loop that `break`s or
 * `return`s on the condition or tests it in its header, or the predicate a
 * `waitForCondition` keeps calling), and as a sub-100ms beat between the parts
 * of one input gesture (keyboard.down → press → up), where there is no
 * observable state between the halves to wait on.
 */
const BLIND_WAIT_CEILING = {
  // Shared machinery. A blind wait here is multiplied by every test that calls
  // the helper, so this is the number that matters most.
  'tests/helpers': 0,
  // Test bodies. Each one affects a single test.
  tests: 11,
  // Stories over real tmux wait on it instead (src/stories/tmuxBarrier.ts).
  'v86 stories': 0,
  stories: 15,
};

/** The source with comments and string/template literals blanked out, offsets kept. */
function codeOnly(content) {
  let out = '';
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    const next = content[i + 1];
    let end = i + 1;
    if (c === '/' && next === '/') {
      end = content.indexOf('\n', i);
      if (end === -1) end = content.length;
    } else if (c === '/' && next === '*') {
      end = content.indexOf('*/', i + 2);
      end = end === -1 ? content.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      end = i + 1;
      while (end < content.length && content[end] !== c) end += content[end] === '\\' ? 2 : 1;
      end += 1;
    } else {
      out += c;
      i += 1;
      continue;
    }
    // Keep the quotes so a blanked string still reads as an argument.
    const span = content.slice(i, end);
    out +=
      c === '/' ? span.replace(/[^\n]/g, ' ') : c + span.slice(1, -1).replace(/[^\n]/g, ' ') + c;
    i = end;
  }
  return out;
}

/** Ranges [open, close] of every loop body that polls a condition. */
function pollLoopBodies(code) {
  const closeOf = new Map();
  const stack = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') stack.push(i);
    else if (code[i] === '}' && stack.length) closeOf.set(stack.pop(), i);
  }

  const bodies = [];
  for (const [open, close] of closeOf) {
    const before = code.slice(0, open).trimEnd();
    if (/\bdo$/.test(before)) {
      bodies.push([open, close]);
      continue;
    }
    // The predicate `waitForCondition(page, async () => { … })` polls.
    if (/\bwaitForCondition\(\s*[\w.]+\s*,\s*(?:async\s*)?\(\s*\)\s*=>$/.test(before)) {
      bodies.push([open, close]);
      continue;
    }
    if (!before.endsWith(')')) continue;
    let depth = 0;
    let paren = before.length - 1;
    for (; paren >= 0; paren--) {
      if (before[paren] === ')') depth++;
      else if (before[paren] === '(' && --depth === 0) break;
    }
    const keyword = before
      .slice(0, paren)
      .trimEnd()
      .match(/\b(while|for)$/)?.[1];
    if (keyword === 'while') {
      bodies.push([open, close]);
    } else if (keyword === 'for') {
      const header = before.slice(paren);
      const body = code.slice(open, close);
      // A condition beside the count in the header (`i < 50 && !ready`) ends
      // the loop the way a `break` on it would.
      const condition = header.split(';')[1] ?? '';
      const polls = /\b(break|return)\b/.test(body) || /&&|\|\|/.test(condition);
      if (!/\b(of|in)\b/.test(header) && polls) bodies.push([open, close]);
    }
  }
  return bodies;
}

function countBlindWaits(content) {
  const code = codeOnly(content);
  const polls = pollLoopBodies(code);
  const sleeps =
    /(?<![\w.])(?<!function\s+)delay\s*\(\s*([^),]*)|await\s+new\s+Promise\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\s*\(\s*\2\s*,\s*([^),]*)/g;
  let count = 0;
  for (const match of code.matchAll(sleeps)) {
    const duration = (match[1] ?? match[3]).trim();
    if (/^\d+$/.test(duration) && Number(duration) < 100) continue;
    if (polls.some(([open, close]) => match.index > open && match.index < close)) continue;
    count++;
  }
  return count;
}

function checkBlindWaitRatchet() {
  const counts = Object.fromEntries(Object.keys(BLIND_WAIT_CEILING).map((k) => [k, 0]));
  const helperDir = path.join(root, 'tests/helpers');

  for (const file of listFiles(path.join(root, 'tests'), new Set(['.js']))) {
    if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    const bucket = file.startsWith(helperDir) ? 'tests/helpers' : 'tests';
    counts[bucket] += countBlindWaits(fs.readFileSync(file, 'utf8'));
  }

  const storyDir = path.join(root, 'packages/tmuxy-ui/src/stories');
  for (const file of listFiles(storyDir, new Set(['.ts', '.tsx']))) {
    const content = fs.readFileSync(file, 'utf8');
    const v86 = /tags:\s*\[[^\]]*'v86'|^\/\/ v86 helpers/m.test(content);
    counts[v86 ? 'v86 stories' : 'stories'] += countBlindWaits(content);
  }

  for (const [bucket, ceiling] of Object.entries(BLIND_WAIT_CEILING)) {
    const count = counts[bucket];
    if (count > ceiling) {
      addError(
        `[tests] ${count} blind waits in ${bucket}/ exceeds the ceiling of ${ceiling}. ` +
          'Use waitForCondition (tests) or waitFor (stories) instead — see ' +
          'BLIND_WAIT_CEILING in bin/check-repo-policy.mjs.',
      );
    } else if (count < ceiling) {
      addError(
        `[tests] ${count} blind waits in ${bucket}/ is below the ceiling of ${ceiling}. ` +
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
checkFileTokenLimit(root, addError);

if (errors.length > 0) {
  console.error('Repo policy checks failed:\n');
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

console.log('Repo policy checks passed.');
