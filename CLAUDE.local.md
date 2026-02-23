# Local Instructions

## Git Workflow

- **Always commit and push** after completing a requested task or bug fix, regardless of which branch you're on.
- When working on a branch that is **not main**, do **not** suggest opening a pull request. Just commit and push directly.

## Browser Testing (E2E / agent-browser)

- **Primary**: Connect to host Chrome via CDP on port 9222 (`agent-browser connect $CHROME_CDP_URL` or `--cdp 9222`).
- **Fallback**: If CDP port 9222 is unavailable (e.g., no host Chrome running), use the **agent-browser internal Chromium**:
  1. Run `agent-browser install` once to download Chromium into `~/.cache/ms-playwright/`.
  2. Then use `agent-browser` commands normally (it launches its own headless Chromium).
  3. E2E tests (`npm run test:e2e`) automatically pick up this Chromium via Playwright's cache — no extra config needed.
