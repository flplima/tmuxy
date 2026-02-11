# IME input handling

## Summary
Handle IME (Input Method Editor) composition correctly to support CJK and other non-ASCII input.

## Problem
Currently, keydown events are sent immediately. During IME composition (e.g., typing Chinese pinyin), partial input is sent before the user finishes composing, resulting in garbled text.

## Solution
Track composition state and suppress key sends during composition:

1. Listen for `compositionstart` → set `isComposing = true`, suppress key sends
2. Listen for `compositionend` → set `isComposing = false`, send composed text
3. Ignore keydown events where `event.isComposing === true` or `event.keyCode === 229`

## Implementation
Add to `keyboardActor.ts`:
- Track `isComposing` state
- Add `compositionstart`/`compositionend` event listeners
- Gate `send-keys` on `!isComposing`

## Success Criteria
- [ ] Chinese/Japanese/Korean input via IME works correctly
- [ ] No partial/garbled text during composition
- [ ] Composed text sent as a single unit after composition ends
- [ ] Dead keys (accented characters) work on macOS/Linux
