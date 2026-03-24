# QA Agent System

Continuous QA for tmuxy using 3 Claude Code agents coordinated via GitHub Issues.

## Architecture

### Agents

Each agent is defined as a Claude agent markdown file in `.claude/agents/` and launched via `claude --agent <name>`.

```
manager  <- coordinates everything, owns git + GitHub Issues
  ├── dev  <- implements fixes, reports via issue comments
  └── qa   <- runs QA checks, creates issues for bugs found
```

| Agent | Role | Socket | Agent File | Communication |
|-------|------|--------|------------|--------------|
| **Manager** | Triages bugs, reviews fixes, manages git | prod | `.claude/agents/manager.md` | Sends prompts to dev/qa via `tmux send-keys` |
| **Dev** | Implements bug fixes | dev | `.claude/agents/dev.md` | Persistent Claude session, receives prompts from manager |
| **QA** | Runs test styles, files issues | prod | `.claude/agents/qa.md` | Persistent Claude session, receives prompts from manager |

### Dual Tmux Servers

| Socket | Purpose | Port | Used by |
|--------|---------|------|---------|
| `tmuxy-prod` | Production deploy | 9000 | Manager, QA |
| `tmuxy-dev` | Development server | 9001 | Dev |

### QA Style Rotation

The manager rotates QA through test styles:

| Style | What it tests |
|-------|--------------|
| `snapshot` | UI vs tmux state drift |
| `flicker` | Visual glitches during operations |
| `input` | Keyboard and mouse interactions |
| `performance` | Latency and memory regressions |
| `verification` | Validates a specific bug fix |

Style definitions are in `.claude/agents/qa/styles/`.

## Bug Lifecycle (GitHub Issues)

```
QA finds bug      --> QA creates GitHub Issue (status:open)
                      OR user creates issue manually
Manager triages   --> assigns dev, adds status:fixing
Dev implements    --> commits with <gitmoji> (#N) <summary>, comments on issue
Manager reviews   --> sends QA verification, adds status:verifying
QA verifies       --> PASS: manager closes issue
                      FAIL: manager adds status:rejected, reassigns dev
```

### User Filtering

Only issues authored by `flplima` or `laika-assistant` are processed. This is enforced at the script level in `lib/gh-issues.sh`. Issues by `flplima` always take priority.

See `lib/protocol.md` for the full GitHub Issues coordination protocol.

## Usage

```bash
# Start everything (tmux servers, web servers, 3 agents)
npm run agents

# Monitor at http://localhost:9000

# Check bug status
gh issue list --label qa-bug

# Check agent sessions
TMUX_SOCKET=tmuxy-prod tmux -L tmuxy-prod list-sessions
TMUX_SOCKET=tmuxy-dev tmux -L tmuxy-dev list-sessions
```

## Directory Structure

```
.claude/
├── start.sh                        # Launcher (pm2 servers + 3 agents + heartbeat)
├── agents/                         # Claude agent definitions (loaded via --agent flag)
│   ├── manager.md                  # Manager agent
│   ├── dev.md                      # Dev agent
│   ├── qa.md                       # QA agent
│   └── qa/
│       └── styles/                 # QA test style definitions
│           ├── snapshot.md
│           ├── flicker.md
│           ├── input.md
│           ├── performance.md
│           └── verification.md
├── lib/
│   ├── gh-issues.sh                # GitHub Issues helper (script-level user filtering)
│   ├── protocol.md                 # GitHub Issues coordination protocol
│   └── issue-template.md           # Bug report template
└── baselines/
    └── performance.json            # Performance baselines (managed by QA perf style)
```

## Monitoring

All agents run as tabs in the tmuxy production web UI at `http://localhost:9000`. Click a tab to observe any agent in real time.

Bug tracking is via GitHub Issues:
```bash
source .claude/lib/gh-issues.sh
gh_issues_open                                    # Prioritized open issues
gh_issues_summary                                 # Quick status
gh issue list --label qa-bug --state closed -L 10 # Recently resolved
```
