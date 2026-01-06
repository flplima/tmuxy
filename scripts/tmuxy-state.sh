#!/bin/bash
# tmuxy-state.sh - Extract tmuxy UI state using pptr
# Returns current windows and panes in YAML format

set -euo pipefail

TMUXY_URL="${TMUXY_URL:-http://localhost:3853}"
TAB_NAME="${TAB_NAME:-tmuxy-state}"

# Ensure pptr daemon is running
if ! pptr status &>/dev/null; then
  echo "Error: pptr daemon not running. Start with: pptr start --launch" >&2
  exit 1
fi

# Navigate to tmuxy (reuses tab if exists)
pptr --tab "$TAB_NAME" goto "$TMUXY_URL" &>/dev/null

# Wait for UI to load
pptr --tab "$TAB_NAME" wait ".window-tab" --timeout 5000 &>/dev/null || {
  echo "Error: tmuxy UI not loaded (no .window-tab found)" >&2
  exit 1
}

# Extract state via JavaScript evaluation
pptr --tab "$TAB_NAME" evaluate '(() => {
  // Extract windows from status bar
  const windows = Array.from(document.querySelectorAll(".window-tab")).map(tab => ({
    id: parseInt(tab.querySelector(".window-index")?.textContent || "0"),
    name: tab.querySelector(".window-name")?.textContent || "",
    active: tab.classList.contains("window-tab-active")
  }));

  // Extract panes from the layout (use .pane-wrapper to avoid duplicates)
  const panes = Array.from(document.querySelectorAll(".pane-wrapper[data-pane-id]")).map(paneEl => {
    const paneId = paneEl.getAttribute("data-pane-id") || "";

    // Get pane header info
    const header = paneEl.querySelector(".pane-header");
    const paneIndex = header?.querySelector(".pane-index")?.textContent || "";
    const command = header?.querySelector(".pane-command")?.textContent ||
                   paneEl.getAttribute("data-pane-command") || "";

    // Check if active
    const isActive = header?.classList.contains("pane-header-active") || false;

    // Get cursor position from data attributes on terminal container
    const terminalContainer = paneEl.querySelector(".terminal-container");
    const cursorX = parseInt(terminalContainer?.getAttribute("data-cursor-x") || "0");
    const cursorY = parseInt(terminalContainer?.getAttribute("data-cursor-y") || "0");

    // Extract screen content as multiline string
    const terminal = paneEl.querySelector(".terminal-content");
    const lines = Array.from(terminal?.querySelectorAll(".terminal-line") || []);
    const screen = lines.map(line => line.textContent || "").join("\n");

    return {
      id: paneId,
      index: parseInt(paneIndex) || 0,
      title: command,
      active: isActive,
      cursor: { x: cursorX, y: cursorY },
      screen
    };
  });

  return { windows, panes };
})()'
