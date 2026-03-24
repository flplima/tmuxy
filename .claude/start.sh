#!/bin/bash
# Start the QA agent system
#
# Usage: npm run agents
#
# 1. Starts prod server (port 9000, tmuxy-prod) and dev server (port 9001, tmuxy-dev) via pm2
# 2. Ensures GitHub labels exist
# 3. Launches 3 agents: manager, dev, qa
# 4. Tails pm2 logs (Ctrl+C to stop watching — servers keep running)
#
# To stop everything: pm2 stop all

set -uo pipefail

WORKSPACE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKSPACE"

# --- Spinner helpers ---

SPINNER_PID=""
spin() {
  local msg="$1"
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local i=0
  while true; do
    printf "\r  \033[36m%s\033[0m %s" "${frames[$i]}" "$msg"
    i=$(( (i + 1) % ${#frames[@]} ))
    sleep 0.08
  done
}

step_start() {
  spin "$1" &
  SPINNER_PID=$!
}

step_done() {
  kill "$SPINNER_PID" 2>/dev/null; wait "$SPINNER_PID" 2>/dev/null || true
  SPINNER_PID=""
  printf "\r  \033[32m✓\033[0m %s\033[K\n" "$1"
}

step_fail() {
  kill "$SPINNER_PID" 2>/dev/null; wait "$SPINNER_PID" 2>/dev/null || true
  SPINNER_PID=""
  printf "\r  \033[31m✗\033[0m %s\033[K\n" "$1"
}

printf "\n  \033[1mtmuxy agents\033[0m\n\n"

# --- Clean up previous instances ---

step_start "Cleaning up old processes"
pm2 stop tmuxy-prod  >/dev/null 2>&1 || true
pm2 stop tmuxy-dev   >/dev/null 2>&1 || true
pm2 delete tmuxy-prod >/dev/null 2>&1 || true
pm2 delete tmuxy-dev  >/dev/null 2>&1 || true
step_done "Cleaned up old processes"

# --- Start servers (sequentially to avoid concurrent compilation OOM) ---

step_start "Starting prod server (port 9000)"
pm2 start ./scripts/prod.sh --name tmuxy-prod --cwd "$WORKSPACE" --silent >/dev/null 2>&1
step_done "Started prod server (port 9000)"

step_start "Compiling prod server"
for i in $(seq 1 180); do
  curl -s http://localhost:9000/health >/dev/null 2>&1 && break
  if [ "$i" -eq 180 ]; then
    step_fail "Prod server timed out — check: pm2 logs"
    exit 1
  fi
  sleep 1
done
step_done "Prod server ready"

# Dev server: reuse the release binary (no cargo-watch needed for agents)
step_start "Starting dev server (port 9001)"
pm2 start ./scripts/prod.sh --name tmuxy-dev --cwd "$WORKSPACE" --silent \
  -- 2>/dev/null || true
# Override: run release binary on dev socket/port
pm2 stop tmuxy-dev >/dev/null 2>&1 || true
pm2 delete tmuxy-dev >/dev/null 2>&1 || true
pm2 start bash --name tmuxy-dev --cwd "$WORKSPACE" --silent -- -c '
  cd /workspace
  tmux -L tmuxy-dev has-session -t tmuxy 2>/dev/null \
    || tmux -L tmuxy-dev new-session -d -s tmuxy -x 200 -y 50
  exec env TMUX_SOCKET=tmuxy-dev cargo run --release -p tmuxy-server -- --port 9001
' >/dev/null 2>&1
step_done "Started dev server (port 9001)"

step_start "Waiting for dev server"
for i in $(seq 1 60); do
  curl -s http://localhost:9001/health >/dev/null 2>&1 && break
  if [ "$i" -eq 60 ]; then
    step_fail "Dev server timed out — check: pm2 logs"
    exit 1
  fi
  sleep 1
done
step_done "Dev server ready"

# --- GitHub labels ---

step_start "Syncing GitHub labels"
for label in qa-bug status:open status:fixing status:verifying status:closed status:rejected \
  severity:critical severity:high severity:medium severity:low \
  category:state-drift category:visual-glitch category:input category:performance; do
  gh label create "$label" --force 2>/dev/null || true
done
step_done "GitHub labels synced"

# --- Launch 3 persistent interactive Claude agent sessions ---
#
# All agents run as `claude --agent <name> --dangerously-skip-permissions`.
# The --agent flag loads the agent definition from .claude/agents/<name>.md,
# which includes the system prompt, allowed tools, and permission mode.
# start.sh sends the initial prompt to the manager via tmux send-keys.
# The manager then sends prompts to dev/qa via tmux send-keys.

# Launch a Claude agent in a pane
launch_claude() {
  local pane="$1" socket="$2" agent="$3"
  tmux -L tmuxy-prod send-keys -t "$pane" \
    "cd $WORKSPACE && TMUX_SOCKET=$socket claude --agent $agent --dangerously-skip-permissions" Enter
}

# Dev: create tab, launch persistent Claude
step_start "Launching dev agent"
DEV_PANE=$(TMUX_SOCKET=tmuxy-prod tmuxy tab create dev 2>/dev/null || echo "")
if [ -n "$DEV_PANE" ]; then
  tmux -L tmuxy-prod set-option -wt tmuxy:dev automatic-rename off 2>/dev/null || true
  launch_claude "$DEV_PANE" "tmuxy-dev" "dev"
fi
step_done "Dev agent launched"

# QA: create tab, launch persistent Claude
step_start "Launching QA agent"
QA_PANE=$(TMUX_SOCKET=tmuxy-prod tmuxy tab create qa 2>/dev/null || echo "")
if [ -n "$QA_PANE" ]; then
  tmux -L tmuxy-prod set-option -wt tmuxy:qa automatic-rename off 2>/dev/null || true
  launch_claude "$QA_PANE" "tmuxy-prod" "qa"
fi
step_done "QA agent launched"

# Manager: window 0, launch persistent Claude
step_start "Launching manager agent"
MANAGER_PANE=$(tmux -L tmuxy-prod list-panes -t tmuxy:0 -F '#{pane_id}' 2>/dev/null | head -1)
tmux -L tmuxy-prod set-option -wt tmuxy:0 automatic-rename off 2>/dev/null || true
tmux -L tmuxy-prod rename-window -t tmuxy:0 manager 2>/dev/null || true
launch_claude "$MANAGER_PANE" "tmuxy-prod" "manager"
step_done "Manager agent launched"

# Complete first-run onboarding if needed (runs claude -p once to initialize config)
step_start "Initializing Claude"
claude --dangerously-skip-permissions -p 'echo initialized' >/dev/null 2>&1 || true
step_done "Claude initialized"

# Wait for Claude sessions to reach the folder trust prompt, then confirm
step_start "Waiting for Claude sessions"
for attempt in $(seq 1 60); do
  PROMPTS=0
  for tab in manager dev qa; do
    tmux -L tmuxy-prod capture-pane -t "tmuxy:$tab" -p 2>/dev/null | grep -q 'trust this folder' && PROMPTS=$((PROMPTS + 1))
  done
  if [ "$PROMPTS" -ge 3 ]; then
    # Confirm folder trust in all panes
    for tab in manager dev qa; do
      tmux -L tmuxy-prod send-keys -t "tmuxy:$tab" Enter 2>/dev/null || true
    done
    break
  fi
  sleep 2
done
# Wait for Claude to finish initializing after trust confirmation
for attempt in $(seq 1 30); do
  READY=0
  for tab in manager dev qa; do
    tmux -L tmuxy-prod capture-pane -t "tmuxy:$tab" -p 2>/dev/null | grep -q 'bypass permissions' && READY=$((READY + 1))
  done
  [ "$READY" -ge 3 ] && break
  sleep 2
done
step_done "Claude sessions ready"

# Send initial prompt to manager (text and Enter must be separate send-keys calls)
# The agent definition is already loaded via --agent flag, so just kick off the monitor loop.
step_start "Sending initial prompt to manager"
tmux -L tmuxy-prod send-keys -t tmuxy:manager 'Start the monitor loop. Source .claude/lib/gh-issues.sh for issue helpers. Check open GitHub issues (gh_issues_open). Send QA the first style rotation (snapshot). Assign dev the highest-priority open issue if any.'
sleep 1
tmux -L tmuxy-prod send-keys -t tmuxy:manager Enter
step_done "Manager prompted"

# --- Summary ---

HOST_IP=$(getent hosts host.docker.internal 2>/dev/null | awk '{print $1}')
[ -z "$HOST_IP" ] && HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "${HOST_PORT:-}" ]; then
  PROD_LOCAL="http://localhost:$HOST_PORT"
  PROD_LAN="http://${HOST_IP:-<host-ip>}:$HOST_PORT"
  DEV_LOCAL="http://localhost:$((HOST_PORT + 1))"
  DEV_LAN="http://${HOST_IP:-<host-ip>}:$((HOST_PORT + 1))"
else
  PROD_LOCAL="http://localhost:9000"
  PROD_LAN="http://${HOST_IP:-<host-ip>}:9000"
  DEV_LOCAL="http://localhost:9001"
  DEV_LAN="http://${HOST_IP:-<host-ip>}:9001"
fi

printf "\n  \033[32m\033[1m▸ Ready\033[0m (3 agents)\n\n"
printf "    prod  %s\n" "$PROD_LOCAL"
printf "          %s\n" "$PROD_LAN"
printf "    dev   %s\n" "$DEV_LOCAL"
printf "          %s\n\n" "$DEV_LAN"
printf "    agents: manager, dev, qa\n"
printf "    pm2 stop all          — stop servers\n"
printf "    gh issue list -l qa-bug\n\n"

# Manager heartbeat loop — re-prompts the manager when idle (every 90s)
# This keeps the terminal open and ensures the manager never stops working.
# Ctrl+C exits the heartbeat (servers + agents keep running via pm2/tmux).
printf "    Heartbeat: re-prompting manager every 90s when idle\n\n"
while true; do
  sleep 90
  # Check if manager is idle (bypass permissions line visible = at prompt, not processing)
  PANE_OUT=$(tmux -L tmuxy-prod capture-pane -t tmuxy:manager -p 2>/dev/null | tail -3)
  if echo "$PANE_OUT" | grep -q 'bypass permissions'; then
    # Build issue summary for the heartbeat prompt (script-level user filtering)
    source "$WORKSPACE/.claude/lib/gh-issues.sh"
    ISSUE_SUMMARY=$(gh_issues_summary 2>/dev/null || echo "Could not fetch issues.")
    tmux -L tmuxy-prod send-keys -t tmuxy:manager "Continue the monitor loop. Check QA and dev status (capture-pane). If either is idle, assign work immediately. QA: send next style rotation. Dev: assign next open issue. Open issues: ${ISSUE_SUMMARY}. Never be idle."
    sleep 1
    tmux -L tmuxy-prod send-keys -t tmuxy:manager Enter
    printf "  \033[36m↻\033[0m Manager re-prompted at %s\n" "$(date +%H:%M:%S)"
  fi
done
