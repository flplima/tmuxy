# E2E Test Suite Deep Audit

A critical analysis identifying "cheating" tests, weak assertions, unnecessary tests, and missed scenarios.

---

## Executive Summary

**Total Tests:** 204
**Solid Tests:** ~150 (74%)
**Problematic Tests:** ~54 (26%)

The test suite has good coverage of core functionality but contains:
- 12 "cheating" tests that pass without testing their claimed behavior
- 16 tests with weak assertions that barely verify anything
- 12 duplicate/redundant tests
- 14 tests with fallback logic that always passes

---

## Category: "Cheating" Tests

Tests that pass but don't actually verify what they claim to test.

### Category 6: Floating Panes (Critical - 8/12 tests are cheating)

| Test | Problem |
|------|---------|
| `FloatPane CSS classes are defined` | Only checks if CSS rules exist in stylesheets, not if float panes work |
| `FloatPane has correct structure when rendered` | Tests if CSS selectors are VALID SYNTAX, not if elements actually exist |
| `PIN_FLOAT event type exists in machine` | Sends event to non-existent pane, checks "no crash" |
| `UNPIN_FLOAT event type exists` | Same - just checks no crash |
| `MOVE_FLOAT event type exists` | Same - just checks no crash |
| `CLOSE_FLOAT event type exists` | Same - just checks no crash |
| `FloatPane component accepts required props` | Just checks React app loads |
| `FloatContainer exists in DOM` | Just checks app-container exists |

**Root Cause:** The `injectFloatState()` helper was written but NEVER CALLED. All tests work around the fact that floating panes can't be created.

**Fix:** Either remove Category 6 entirely or implement actual float pane creation for testing.

### Category 12: Popup Support (Critical - 6/8 tests are cheating)

| Test | Problem |
|------|---------|
| `Popup command executes in tmux without error` | Wraps in try/catch, passes if "no crash" |
| `Session remains stable after popup closes` | Same - catches errors, always passes |
| `Multiple popup commands do not crash session` | Same pattern |
| `Popup renders centered when state is injected` | Calculates expected center values but never renders a popup |
| `Popup z-index layering is correct` | Returns hardcoded values (999, 1000), not actual computed styles |
| `Popup component has correct structure` | Just checks both overlay and container are null (consistent) |

**Root Cause:** The `injectPopupState()` helper was written but NEVER CALLED. Popup functionality isn't working so tests pretend.

### Category 11: OSC Protocols (4/6 tests weak)

| Test | Problem |
|------|---------|
| `OSC 8 hyperlink renders` | Only checks text "Click Here" displays, not that it's actually a hyperlink |
| `Hyperlink text displays correctly` | Same - no `<a>` element verification |
| `Multiple hyperlinks on same line` | Same |
| `OSC 52 sequence is handled` | Only checks `session.exists()` - trivially true |
| `Terminal handles clipboard without error` | Only checks `session.exists()` |

**Fix:** OSC 8 tests should verify:
```javascript
const link = await ctx.page.$('a[href="https://example.com"]');
expect(link).not.toBeNull();
```

---

## Category: Weak Assertions

Tests that have assertions so weak they barely test anything.

### Category 2: Keyboard Input

| Test | Problem |
|------|---------|
| `Ctrl+L - clears screen` | Only checks `textAfter` is defined, not that clearing happened |
| `F1-F12 function keys are sent` | Only checks `session.exists()` |
| `F-keys dont break terminal` | Same - just checks session exists after |
| `Composition events are handled` | Just types regular text, doesn't test actual IME composition |

### Category 7: Mouse Events

| Test | Problem |
|------|---------|
| `Mouse clicks are sent to mouse-aware applications` | Only checks `session.exists()` after clicking in `less` |
| `Rapid mouse movements do not break app` | Same |

### Category 8: Copy Mode

| Test | Problem |
|------|---------|
| `Navigate with hjkl keys in copy mode` | Only checks "still in copy mode", not that cursor moved |
| `Navigate with arrow keys in copy mode` | Same |
| `Page up/down navigation` | Checks scroll position changed but not by how much |
| `Go to beginning/end of line` | Only checks "still in copy mode" |
| `Start selection with v key` | Only checks "still in copy mode" |
| `Search forward with /` | Only checks "still in copy mode", not that search found text |
| `Search backward with ?` | Same |
| `Repeat search with n and N` | Same |

---

## Category: Duplicate/Redundant Tests

### Category 2.6: Keyboard Helpers Integration (All 6 tests are duplicates)

These duplicate tests from sections 2.2 and 2.5:

| Duplicate Test | Original Test |
|----------------|---------------|
| `splitPaneKeyboard helper creates pane` | `Prefix+" splits pane horizontally via keyboard` |
| `navigatePaneKeyboard helper navigates panes` | `Prefix+Arrow navigates panes via keyboard` |
| `toggleZoomKeyboard helper toggles zoom` | `Prefix+z toggles zoom via keyboard` |
| `createWindowKeyboard helper creates window` | `Prefix+c creates new window via keyboard` |
| `nextWindowKeyboard and prevWindowKeyboard` | `Prefix+n/p switches windows via keyboard` |
| `killPaneKeyboard helper kills pane` | `Prefix+x kills pane via keyboard` |

**Recommendation:** Remove section 2.6 entirely. Helper functions are implementation details, not user-facing behavior.

### Category 14.6: Unicode & Internationalization

| Test | Problem |
|------|---------|
| `English text output` | Trivial - echoing English always works |
| `Box drawing characters` | Tests ASCII `+---+`, not actual box drawing Unicode |

**Note:** Category 1.4 already has proper CJK/emoji tests, making 14.6 redundant.

---

## Category: Fallback Logic That Always Passes

Tests that fall back to tmux commands when UI elements aren't found, making them always pass even if UI is broken.

### Category 7: Mouse Events

```javascript
// 7.4 Pane Resize via Drag
const divider = await ctx.page.$('.resize-divider-horizontal, ...');
if (divider) {
  // Test UI resize
} else {
  // Fallback: use tmux resize - TEST ALWAYS PASSES
  ctx.session.resizePane('D', 5);
}
```

Both resize tests have this pattern.

### Category 9: Status Bar

```javascript
// 9.3 Close button on window tab
const closeBtn = await ctx.page.$('.window-tab-close, ...');
if (closeBtn) {
  await closeBtn.click();
} else {
  // Fallback: use tmux command - TEST ALWAYS PASSES
  ctx.session.killWindow(2);
}
```

Similar patterns in:
- `Menu trigger button exists` - just logs and continues
- `New window button creates window` - falls back to tmux

---

## Missing Test Scenarios

### 1. Actual Float Pane Functionality
No tests verify:
- Creating a float pane
- Dragging a float pane
- Resizing a float pane
- Pinning/unpinning
- Closing a float pane

### 2. Actual Popup Rendering
No tests verify:
- Popup appears visually
- Popup can be dismissed
- Popup content is rendered

### 3. OSC Protocol Functionality
- OSC 8: No test for clicking a hyperlink
- OSC 52: No test for clipboard content being set

### 4. Copy Mode Cursor Position
No tests verify cursor moved to expected position after navigation commands.

### 5. Real IME Input
The IME test just types regular text. Should test actual composition events:
```javascript
await page.evaluate(() => {
  const event = new CompositionEvent('compositionstart', { data: '' });
  document.activeElement.dispatchEvent(event);
});
```

---

## Recommendations

### Immediate Actions

1. **Remove Category 2.6** - All 6 tests are duplicates (-6 tests)

2. **Remove or rewrite Category 6** - 8/12 tests don't test floating panes
   - Either implement float state injection
   - Or remove the category until feature works

3. **Remove or rewrite Category 12** - 6/8 tests don't test popups
   - Either implement popup state injection
   - Or mark as "feature not implemented"

4. **Fix OSC 8 tests** - Add hyperlink element verification:
   ```javascript
   const links = await ctx.page.$$('[role="log"] a[href]');
   expect(links.length).toBeGreaterThan(0);
   ```

5. **Fix OSC 52 test** - Actually verify clipboard (if possible)

6. **Remove fallback logic** - Tests should fail if UI element not found, not silently pass

### Medium-term Improvements

1. **Strengthen copy mode tests** - Verify cursor position, not just "still in copy mode"

2. **Add real IME test** - Use Playwright's composition events API

3. **Remove Category 14.6** - Duplicates Category 1.4

---

## Test Quality Summary by Category

| Category | Total | Solid | Cheating | Weak | Duplicate |
|----------|-------|-------|----------|------|-----------|
| 1. Basic Connectivity | 27 | 25 | 0 | 2 | 0 |
| 2. Keyboard Input | 31 | 21 | 1 | 3 | 6 |
| 3. Pane Operations | 16 | 16 | 0 | 0 | 0 |
| 4. Window Operations | 15 | 15 | 0 | 0 | 0 |
| 5. Pane UI Structure | 11 | 10 | 0 | 1 | 0 |
| 6. Floating Panes | 12 | 4 | 8 | 0 | 0 |
| 7. Mouse Events | 13 | 9 | 0 | 2 | 2 |
| 8. Copy Mode | 17 | 9 | 0 | 8 | 0 |
| 9. Status Bar | 14 | 10 | 0 | 0 | 4 |
| 10. Session/Connection | 12 | 12 | 0 | 0 | 0 |
| 11. OSC Protocols | 6 | 2 | 2 | 2 | 0 |
| 12. Popup Support | 8 | 2 | 6 | 0 | 0 |
| 13. Performance | 8 | 8 | 0 | 0 | 0 |
| 14. Workflows | 14 | 12 | 0 | 0 | 2 |
| **TOTAL** | **204** | **155** | **17** | **18** | **14** |

**Effective Coverage:** 155/204 = 76%
