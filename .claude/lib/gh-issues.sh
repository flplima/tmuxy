#!/usr/bin/env bash
#
# GitHub Issues helper with user-level filtering.
#
# SECURITY: Only issues/PRs authored by ALLOWED_AUTHORS are returned.
# This is enforced at the script level so agent prompts cannot bypass it.
#
# Usage:
#   source .claude/lib/gh-issues.sh
#   gh_issues_open          # All open issues from allowed authors, prioritized
#   gh_issues_next          # Single highest-priority issue to work on
#   gh_issues_by_status "status:fixing"  # Filter by status label
#   gh_issues_allowed_author "flplima"   # Check if author is allowed
#

set -uo pipefail

# --- Allowed authors (script-level enforcement) ---
ALLOWED_AUTHORS=("flplima" "laika-assistant")

gh_issues_allowed_author() {
  local author="$1"
  for a in "${ALLOWED_AUTHORS[@]}"; do
    [[ "$a" == "$author" ]] && return 0
  done
  return 1
}

# List open issues from allowed authors, sorted by priority:
#   1. Issues by flplima (user) first
#   2. Issues by laika-assistant (agent) second
#   3. Within each group: severity:critical > high > medium > low
gh_issues_open() {
  local all_issues
  all_issues=$(gh issue list --state open --json number,title,labels,author,createdAt \
    --jq '[.[] | select(.author.login == "flplima" or .author.login == "laika-assistant")]' 2>/dev/null)

  if [ -z "$all_issues" ] || [ "$all_issues" = "[]" ]; then
    echo "[]"
    return
  fi

  # Sort: flplima first, then by severity (critical > high > medium > low)
  echo "$all_issues" | jq '
    def severity_rank:
      if any(.labels[]; .name == "severity:critical") then 0
      elif any(.labels[]; .name == "severity:high") then 1
      elif any(.labels[]; .name == "severity:medium") then 2
      elif any(.labels[]; .name == "severity:low") then 3
      else 4 end;
    def author_rank:
      if .author.login == "flplima" then 0 else 1 end;
    sort_by([author_rank, severity_rank])
  '
}

# Get the single highest-priority open issue to work on next
gh_issues_next() {
  gh_issues_open | jq '.[0] // empty'
}

# List issues by status label (e.g., "status:fixing", "status:verifying")
gh_issues_by_status() {
  local status_label="$1"
  gh issue list --state open --label "$status_label" \
    --json number,title,labels,author,createdAt \
    --jq "[.[] | select(.author.login == \"flplima\" or .author.login == \"laika-assistant\")]" 2>/dev/null
}

# Compact one-line summary of open issues for heartbeat prompts
gh_issues_summary() {
  local issues
  issues=$(gh_issues_open)
  if [ "$issues" = "[]" ] || [ -z "$issues" ]; then
    echo "No open issues."
    return
  fi
  echo "$issues" | jq -r '.[] | "#\(.number) [\(.author.login)] \(.title)"'
}
