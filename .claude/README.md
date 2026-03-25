# QA Agent System

Continuous QA for tmuxy using 3 Claude Code agents coordinated via `tmuxy event` and GitHub Issues.

## Architecture

### Agents

```
manager  <- persistent Claude session, coordinates everything, owns git + GitHub Issues
  ├── dev  <- event-driven while-loop: waits for event → claude -p → exit → repeat
  └── qa   <- event-driven while-loop: waits for event → claude -p → exit → repeat
```

| Agent | Role | Socket | Agent File | Communication |
|-------|------|--------|------------|--------------|
| **Manager** | Triages bugs, reviews fixes, manages git | prod | `.claude/agents/manager.md` | Emits events via `tmuxy event emit start_dev` / `start_qa` |
| **Dev** | Implements bug fixes | dev | `.claude/agents/dev.md` | Blocks on `tmuxy event wait start_dev`, runs `claude -p` per task |
| **QA** | Runs test styles, files issues | prod | `.claude/agents/qa.md` | Blocks on `tmuxy event wait start_qa`, runs `claude -p` per task |

### Event System

The `tmuxy event` commands provide a file-based message queue using `tmux wait-for` for signaling:

```bash
tmuxy event emit <name> <message>     # Publish (queued, ordered)
tmuxy event wait <name>               # Block until message arrives
tmuxy event list                      # Show pending events
```

Events are stored at `/tmp/tmuxy-events/<socket>/<name>/` as numbered message files. Queue semantics: ordered, single-consumer, consumed messages deleted.

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
Manager triages   --> assigns dev via tmuxy event emit, adds status:fixing
Dev implements    --> commits with <gitmoji> (#N) <summary>, comments on issue
Manager reviews   --> sends QA verification via tmuxy event emit, adds status:verifying
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

# Manually send work to agents
TMUX_SOCKET=tmuxy-prod tmuxy event emit start_dev 'Fix issue #99: ...'
TMUX_SOCKET=tmuxy-prod tmuxy event emit start_qa 'Run snapshot style'
```

## Directory Structure

```
.claude/
├── start.sh                        # Launcher (pm2 servers + 3 agents + heartbeat)
├── agents/                         # Claude agent definitions (loaded via --agent flag)
│   ├── manager.md                  # Manager agent (persistent)
│   ├── dev.md                      # Dev agent (single-shot per event)
│   ├── qa.md                       # QA agent (single-shot per event)
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
