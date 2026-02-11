# Actor Refactor: Factory Pattern + Simplified Actors

## Goal

Refactor all XState actors to use a **factory function pattern** with explicit dependency injection. Simplify the keyboard handling by removing frontend-reimplemented tmux logic. Consolidate DOM interactions into purpose-built actors.

**Pattern**: `createXxxActor(DEPENDENCY) => fromCallback(...)`

Principles:
- **Actors** = long-lived subscriptions to the external world (WebSocket, DOM listeners, anime.js)
- **Machines** = stateful multi-step behavior with no DOM access
- **Components** = declarative rendering + element-scoped event handlers that send events to the machine
- **No DOM access in machines** — machines receive data, never query the DOM

---

## Current State

| Thing | File | What it does | Pattern |
|-------|------|--------------|---------|
| tmuxActor | `machines/app/tmuxActor.ts` | WebSocket comm | `fromCallback` (adapter created internally) |
| keyboardMachine | `machines/keyboard/keyboardMachine.ts` | Key listener + prefix/command states | `setup().createMachine()` with embedded `fromCallback` |
| dragMachine | `machines/drag/dragMachine.ts` | Pane drag-to-swap | `setup().createMachine()` + `document.querySelector` inside |
| resizeMachine | `machines/resize/resizeMachine.ts` | Pane resize | `setup().createMachine()` |
| useLayoutAnimation | `hooks/useLayoutAnimation.ts` | anime.js enter/exit/drag | React hook (imperative DOM) |
| useGlobalMouseEvents | `hooks/useGlobalMouseEvents.ts` | mousemove/mouseup during drag/resize | React hook (conditional listener) |
| useWindowResize | `hooks/useWindowResize.ts` | window.resize + char measurement | React hook → sends to machine |
| useContainerSize | `hooks/useContainerSize.ts` | ResizeObserver on container | React hook → local state |
| useActivityTracker | `hooks/useActivityTracker.ts` | Global module with listener set | Standalone module |
| usePaneScroll | `hooks/usePaneScroll.ts` | Wheel debounce → tmux scroll | React hook |
| useClickOutside | `hooks/useClickOutside.ts` | Menu close on outside click/key | React hook |
| hidePaneElements | `machines/app/appMachine.ts` | Adds .pane-leaving class | Direct DOM in machine action |

---

## Target State

| Actor | File | Factory Signature | Responsibility |
|-------|------|-------------------|----------------|
| tmuxActor | `machines/actors/tmuxActor.ts` | `createTmuxActor(adapter)` | WebSocket lifecycle |
| keyboardActor | `machines/actors/keyboardActor.ts` | `createKeyboardActor()` | keydown → format → send-keys |
| animationActor | `machines/actors/animationActor.ts` | `createAnimationActor(rootEl)` | anime.js layout, drag transforms |
| sizeActor | `machines/actors/sizeActor.ts` | `createSizeActor(measureFn)` | window.resize + ResizeObserver |

| Machine | File | Responsibility |
|---------|------|----------------|
| dragMachine | `machines/drag/dragMachine.ts` | idle/dragging states, spawns pointer listener |
| resizeMachine | `machines/resize/resizeMachine.ts` | idle/resizing states, spawns pointer listener |

| Deleted | Reason |
|---------|--------|
| keyboardMachine | Replaced by simple `createKeyboardActor` — tmux handles prefix natively |
| useLayoutAnimation | Replaced by `createAnimationActor` |
| useGlobalMouseEvents | Moved into drag/resize machines as spawned callbacks |
| useWindowResize | Replaced by `createSizeActor` |
| useContainerSize | Merged into `createSizeActor` |
| useActivityTracker | Replaced by `lastUpdateTime` in machine context |

| Kept as React hook/handler | Reason |
|----------------------------|--------|
| usePaneScroll | Component-scoped onWheel, debounce is local concern |
| useClickOutside | Purely UI-local (menu close), no machine involvement |
| onMouseDown on PaneHeader | Element-scoped → sends DRAG_START |
| onMouseDown on ResizeDividers | Element-scoped → sends RESIZE_START |
| onClick on WindowTabs | Element-scoped → sends SEND_COMMAND |

---

## 1. `createKeyboardActor()`

**The entire keyboard machine is replaced by a ~30-line `fromCallback` actor.** All prefix logic, pane navigation shortcuts, and command mode are removed. Tmux handles its own prefix key, bindings, and command prompt natively.

```typescript
// machines/actors/keyboardActor.ts
import { fromCallback, AnyActorRef } from 'xstate';

export type KeyboardActorEvent =
  | { type: 'UPDATE_SESSION'; sessionName: string };

export interface KeyboardActorInput { parent: AnyActorRef }

const KEY_MAP: Record<string, string> = {
  Enter: 'Enter', Backspace: 'BSpace', Delete: 'DC',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Tab: 'Tab', Escape: 'Escape', Home: 'Home', End: 'End',
  PageUp: 'PPage', PageDown: 'NPage', Insert: 'IC',
  ' ': 'Space',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};

function formatTmuxKey(event: KeyboardEvent): string {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('C');
  if (event.altKey || event.metaKey) modifiers.push('M');
  if (event.shiftKey && event.key.length > 1) modifiers.push('S');

  const mapped = KEY_MAP[event.key];
  if (mapped) {
    return modifiers.length > 0 ? `${modifiers.join('-')}-${mapped}` : mapped;
  } else if (event.key.length === 1) {
    return modifiers.length > 0 ? `${modifiers.join('-')}-${event.key.toLowerCase()}` : event.key;
  }
  return '';
}

export function createKeyboardActor() {
  return fromCallback<KeyboardActorEvent, KeyboardActorInput>(({ input, receive }) => {
    let sessionName = 'tmuxy';

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      const key = formatTmuxKey(event);
      if (!key) return;

      // Send formatted key to tmux
      input.parent.send({
        type: 'SEND_TMUX_COMMAND',
        command: `send-keys -t ${sessionName} ${key}`,
      });

      // Notify parent for UI-level key handling (Escape cancels drag/resize)
      input.parent.send({
        type: 'KEY_PRESS',
        key: event.key,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
      });
    };

    window.addEventListener('keydown', handleKeyDown);

    receive((event) => {
      if (event.type === 'UPDATE_SESSION') {
        sessionName = event.sessionName;
      }
    });

    return () => window.removeEventListener('keydown', handleKeyDown);
  });
}
```

**What's removed:**
- `prefixWait` state + PREFIX_TIMEOUT → tmux handles prefix natively
- `commandMode` state → use tmux's `prefix + :` command prompt
- `PREFIX_BINDINGS` map → tmux's own bindings
- `PANE_NAV_MAP` (C-h/j/k/l) → user's `.tmux.conf` with `bind -n`
- `sendParent` action wrappers → direct `input.parent.send`
- 280 lines of state machine definition

**What tmux handles instead:**
- Prefix key (Ctrl+a or Ctrl+b) — tmux enters prefix-wait state
- Binding lookup (prefix + % = split, prefix + c = new-window, etc.)
- Command prompt (prefix + : opens tmux's command line in the status bar)
- Prefix timeout (tmux's `display-time` option)

**What the UI loses (acceptable tradeoffs):**
- "PREFIX" indicator in status bar → could detect via `#{client_prefix}` if needed later
- Frontend-imposed pane nav → user configures in `.tmux.conf`
- In-UI command input → tmux's native command prompt works fine

---

## 2. `createTmuxActor(adapter: TmuxAdapter)`

Refactor the existing `tmuxActor` to accept the adapter as an argument.

```typescript
// machines/actors/tmuxActor.ts
import { fromCallback, AnyActorRef } from 'xstate';
import type { TmuxAdapter, ServerState } from '../../tmux/types';

export type TmuxActorEvent = { type: 'SEND_COMMAND'; command: string };
export interface TmuxActorInput { parent: AnyActorRef }

export function createTmuxActor(adapter: TmuxAdapter) {
  return fromCallback<TmuxActorEvent, TmuxActorInput>(({ input, receive }) => {
    const unsubState = adapter.onStateChange((state) => {
      input.parent.send({ type: 'TMUX_STATE_UPDATE', state });
    });
    const unsubError = adapter.onError((error) => {
      input.parent.send({ type: 'TMUX_ERROR', error });
    });
    const unsubConnInfo = adapter.onConnectionInfo((connectionId, isPrimary) => {
      input.parent.send({ type: 'CONNECTION_INFO', connectionId, isPrimary });
    });
    const unsubPrimary = adapter.onPrimaryChanged((isPrimary) => {
      input.parent.send({ type: 'PRIMARY_CHANGED', isPrimary });
    });

    adapter.connect().then(async () => {
      input.parent.send({ type: 'TMUX_CONNECTED' });
      const state = await adapter.invoke<ServerState>('get_initial_state');
      input.parent.send({ type: 'TMUX_STATE_UPDATE', state });
    }).catch((error) => {
      input.parent.send({ type: 'TMUX_ERROR', error: error.message });
    });

    receive((event) => {
      if (event.type === 'SEND_COMMAND') {
        adapter.invoke<void>('run_tmux_command', { command: event.command }).catch((error) => {
          input.parent.send({ type: 'TMUX_ERROR', error: error.message });
        });
      }
    });

    return () => {
      unsubState();
      unsubError();
      unsubConnInfo();
      unsubPrimary();
      adapter.disconnect();
    };
  });
}
```

---

## 3. `createAnimationActor(rootEl: HTMLElement)`

Consolidates all animation logic. Receives events from the machine, performs imperative animations, reports completion.

### Events Received

```typescript
type AnimationActorEvent =
  | { type: 'PANES_ENTERING'; paneIds: string[] }
  | { type: 'PANES_LEAVING'; paneIds: string[] }
  | { type: 'DRAG_TRANSFORM'; x: number; y: number; paneId: string }
  | { type: 'DRAG_END'; paneId: string; lastOffset: { x: number; y: number } }
  | { type: 'DRAG_CANCEL' }
  | { type: 'PLACEHOLDER_SHOW'; paneId: string }
  | { type: 'PLACEHOLDER_MOVE'; position: { left: number; top: number; width: number; height: number } }
  | { type: 'PLACEHOLDER_HIDE' }
```

### Events Sent

```typescript
| { type: 'ANIMATION_LEAVE_COMPLETE' }
| { type: 'ANIMATION_DRAG_COMPLETE' }
```

### Implementation

```typescript
// machines/actors/animationActor.ts
import { fromCallback, AnyActorRef } from 'xstate';
import { createLayout, animate, type AutoLayout } from 'animejs';
import { PANE_ANIMATION_DURATION, calculateAnimationDuration } from '../constants';

export interface AnimationActorInput { parent: AnyActorRef }

export function createAnimationActor(rootEl: HTMLElement) {
  return fromCallback<AnimationActorEvent, AnimationActorInput>(({ input, receive }) => {
    const layout: AutoLayout = createLayout(rootEl, {
      children: '[data-pane-id].pane-layout-item',
      enterFrom: { opacity: 0, scale: 0.85, translateY: 50 },
      leaveTo: { opacity: 0, scale: 0.85, translateY: 50 },
      duration: PANE_ANIMATION_DURATION,
      ease: 'linear',
    });

    let dragAnimation: ReturnType<typeof animate> | null = null;
    let placeholderEl: HTMLElement | null = null;

    receive((event) => {
      switch (event.type) {
        case 'PANES_ENTERING':
          layout.record();
          requestAnimationFrame(() => layout.animate());
          break;

        case 'PANES_LEAVING':
          for (const id of event.paneIds) {
            const el = rootEl.querySelector(`[data-pane-id="${id}"]`) as HTMLElement;
            if (el) el.classList.add('pane-leaving');
          }
          setTimeout(() => input.parent.send({ type: 'ANIMATION_LEAVE_COMPLETE' }), PANE_ANIMATION_DURATION);
          break;

        case 'DRAG_TRANSFORM': {
          const el = rootEl.querySelector(`[data-pane-id="${event.paneId}"]`) as HTMLElement;
          if (el) { el.style.transform = `translate(${event.x}px, ${event.y}px)`; el.style.zIndex = '100'; }
          break;
        }

        case 'DRAG_END': {
          const el = rootEl.querySelector(`[data-pane-id="${event.paneId}"]`) as HTMLElement;
          if (!el) break;
          el.style.transition = 'none';
          el.style.transform = `translate(${event.lastOffset.x}px, ${event.lastOffset.y}px)`;
          el.offsetHeight; // reflow
          const dur = calculateAnimationDuration(event.lastOffset.x, event.lastOffset.y, 0, 0);
          dragAnimation = animate(el, {
            transform: 'translate(0px, 0px)', duration: dur, ease: 'linear',
            onComplete: () => {
              el.style.transform = ''; el.style.zIndex = ''; el.style.transition = '';
              dragAnimation = null;
              input.parent.send({ type: 'ANIMATION_DRAG_COMPLETE' });
            },
          });
          break;
        }

        case 'DRAG_CANCEL':
          if (dragAnimation) { dragAnimation.pause(); dragAnimation = null; }
          rootEl.querySelectorAll('.pane-layout-item').forEach((el) => {
            (el as HTMLElement).style.transform = '';
            (el as HTMLElement).style.zIndex = '';
            (el as HTMLElement).style.transition = '';
          });
          break;

        case 'PLACEHOLDER_SHOW': {
          const paneEl = rootEl.querySelector(`[data-pane-id="${event.paneId}"]`) as HTMLElement;
          if (!paneEl) break;
          if (!placeholderEl) { placeholderEl = document.createElement('div'); placeholderEl.className = 'pane-drag-placeholder'; rootEl.appendChild(placeholderEl); }
          const s = window.getComputedStyle(paneEl);
          Object.assign(placeholderEl.style, { position: 'absolute', left: s.left, top: s.top, width: s.width, height: s.height, opacity: '1', pointerEvents: 'none' });
          break;
        }

        case 'PLACEHOLDER_MOVE':
          if (!placeholderEl) break;
          const cl = parseFloat(placeholderEl.style.left) || 0;
          const ct = parseFloat(placeholderEl.style.top) || 0;
          animate(placeholderEl, { ...event.position, duration: calculateAnimationDuration(cl, ct, event.position.left, event.position.top), ease: 'linear' });
          break;

        case 'PLACEHOLDER_HIDE':
          if (!placeholderEl) break;
          const ph = placeholderEl;
          animate(ph, { opacity: 0, duration: PANE_ANIMATION_DURATION, ease: 'linear', onComplete: () => { ph.remove(); placeholderEl = null; } });
          break;
      }
    });

    return () => { layout.revert(); if (dragAnimation) dragAnimation.pause(); if (placeholderEl) placeholderEl.remove(); };
  });
}
```

---

## 4. `createSizeActor(measureFn)`

Replaces `useWindowResize` + `useContainerSize`. Manages window resize listener + ResizeObserver, sends size events to parent.

```typescript
// machines/actors/sizeActor.ts
import { fromCallback, AnyActorRef } from 'xstate';

export type SizeActorEvent =
  | { type: 'OBSERVE_CONTAINER'; element: HTMLElement }
  | { type: 'STOP_OBSERVE' };

export interface SizeActorInput { parent: AnyActorRef }

interface MeasureFn {
  (): { charWidth: number; charHeight: number };
}

const RESIZE_DEBOUNCE_MS = 100;

export function createSizeActor(measureFn: MeasureFn) {
  return fromCallback<SizeActorEvent, SizeActorInput>(({ input, receive }) => {
    let containerObserver: ResizeObserver | null = null;
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastCols = 0;
    let lastRows = 0;

    // Measure char size and send immediately
    const { charWidth, charHeight } = measureFn();
    input.parent.send({ type: 'SET_CHAR_SIZE', charWidth, charHeight });

    // Calculate and send target size
    const updateTargetSize = () => {
      const availableWidth = window.innerWidth;
      const availableHeight = window.innerHeight;
      // Calculate cols/rows from available space (using constants for padding/status bar)
      const cols = Math.floor(availableWidth / charWidth);
      const rows = Math.floor(availableHeight / charHeight);
      if (cols !== lastCols || rows !== lastRows) {
        lastCols = cols;
        lastRows = rows;
        input.parent.send({ type: 'SET_TARGET_SIZE', cols, rows });
      }
    };

    updateTargetSize();

    // Debounced window resize
    const handleResize = () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(updateTargetSize, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', handleResize);

    // Container observation (for centering calculations)
    receive((event) => {
      if (event.type === 'OBSERVE_CONTAINER') {
        containerObserver?.disconnect();
        containerObserver = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry) {
            input.parent.send({
              type: 'SET_CONTAINER_SIZE',
              width: entry.contentRect.width,
              height: entry.contentRect.height,
            });
          }
        });
        containerObserver.observe(event.element);
      }
      if (event.type === 'STOP_OBSERVE') {
        containerObserver?.disconnect();
        containerObserver = null;
      }
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeTimeout) clearTimeout(resizeTimeout);
      containerObserver?.disconnect();
    };
  });
}
```

---

## 5. Drag/Resize Machines — Spawned Pointer Listeners

Remove `useGlobalMouseEvents` hook. Each machine spawns its own pointer-tracking callback when entering the active state.

### dragMachine

```typescript
// In dragMachine definition:
states: {
  idle: { /* ... */ },
  dragging: {
    invoke: {
      id: 'pointerTracker',
      src: fromCallback(({ sendBack }) => {
        const onMove = (e: MouseEvent) => sendBack({ type: 'DRAG_MOVE', clientX: e.clientX, clientY: e.clientY });
        const onUp = () => sendBack({ type: 'DRAG_END' });
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
      }),
    },
    on: {
      DRAG_MOVE: { /* calculate target, send swap command, send animation events */ },
      DRAG_END: { target: 'idle', actions: [...] },
    },
  },
}
```

### resizeMachine

```typescript
// Same pattern:
resizing: {
  invoke: {
    id: 'pointerTracker',
    src: fromCallback(({ sendBack }) => {
      const onMove = (e: MouseEvent) => sendBack({ type: 'RESIZE_MOVE', clientX: e.clientX, clientY: e.clientY });
      const onUp = () => sendBack({ type: 'RESIZE_END' });
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
    }),
  },
}
```

### Remove DOM access from dragMachine

```typescript
// Before (inside DRAG_MOVE action):
const container = document.querySelector('.pane-layout');
const containerRect = container?.getBoundingClientRect();

// After: containerRect is passed as part of the event from the component,
// or the machine uses containerSize from parent context:
DRAG_MOVE: {
  actions: enqueueActions(({ context, event }) => {
    // Use context.containerWidth/containerHeight (from sizeActor)
    // instead of querying DOM
  })
}
```

---

## 6. `appMachine` Changes

### Remove keyboard machine, add actors

```typescript
// Before:
invoke: [
  { id: 'tmux', src: 'tmuxActor' },
  { id: 'keyboardLogic', src: 'keyboardMachine' },
  { id: 'dragLogic', src: 'dragMachine' },
  { id: 'resizeLogic', src: 'resizeMachine' },
]

// After:
invoke: [
  { id: 'tmux', src: 'tmuxActor' },
  { id: 'keyboard', src: 'keyboardActor' },
  { id: 'size', src: 'sizeActor' },
  { id: 'dragLogic', src: 'dragMachine' },
  { id: 'resizeLogic', src: 'resizeMachine' },
]
// animation actor spawned dynamically once DOM root is available
```

### Remove prefix/command mode from context and events

```typescript
// Remove from context:
- prefixMode: boolean
- commandInput: string

// Remove events:
- COMMAND_MODE_ENTER, COMMAND_MODE_EXIT, COMMAND_INPUT, COMMAND_SUBMIT
- COMMAND_MODE_CHANGED, PREFIX_MODE_CHANGED

// Remove from StatusBar:
- Prefix indicator
- Command input field
```

### Replace `removingPane` timer with animation event

```typescript
removingPane: {
  on: {
    ANIMATION_LEAVE_COMPLETE: {
      target: 'idle',
      actions: /* apply pendingUpdate */
    },
    // Still queue state updates during animation
    TMUX_STATE_UPDATE: { actions: /* update pendingUpdate */ },
  }
}
```

### Add container size to context

```typescript
context: {
  // ... existing
  containerWidth: 0,
  containerHeight: 0,
}

// Handle from sizeActor:
SET_CONTAINER_SIZE: {
  actions: assign(({ event }) => ({
    containerWidth: event.width,
    containerHeight: event.height,
  }))
}
```

### Activity tracking via context

```typescript
// Replace useActivityTracker module:
context: {
  lastUpdateTime: 0,  // Set on each TMUX_STATE_UPDATE
}

// In component:
const lastUpdateTime = useAppSelector(s => s.context.lastUpdateTime);
const isRapidlyUpdating = Date.now() - lastUpdateTime < 100;
```

---

## 7. `PaneLayout.tsx` Simplification

After refactor, PaneLayout becomes purely declarative:

```typescript
export function PaneLayout() {
  const send = useAppSend();
  const visiblePanes = useAppSelector(selectVisiblePanes);
  const { charWidth, charHeight, totalWidth, totalHeight } = useAppSelector(selectGridDimensions);
  const { containerWidth, containerHeight } = useAppSelector(selectContainerSize);
  const containerRef = useRef<HTMLDivElement>(null);

  // Tell size actor to observe this container
  useEffect(() => {
    if (containerRef.current) {
      send({ type: 'OBSERVE_CONTAINER', element: containerRef.current });
      send({ type: 'SET_ANIMATION_ROOT', element: containerRef.current });
    }
  }, []);

  // Calculate positions (pure math, no DOM)
  const centerOffsetX = Math.max(0, (containerWidth - totalWidth * charWidth) / 2);
  const centerOffsetY = Math.max(0, (containerHeight - totalHeight * charHeight) / 2);

  return (
    <div ref={containerRef} className="pane-layout">
      {visiblePanes.map((pane) => (
        <div key={pane.tmuxId} data-pane-id={pane.tmuxId}
          className="pane-layout-item"
          style={getPaneStyle(pane, charWidth, charHeight, centerOffsetX, centerOffsetY)}>
          <Pane paneId={pane.tmuxId} />
        </div>
      ))}
      <ResizeDividers centerOffsetX={centerOffsetX} centerOffsetY={centerOffsetY} />
    </div>
  );
}
```

**Removed from PaneLayout:**
- `useLayoutAnimation` hook
- `useGlobalMouseEvents` hook
- `useContainerSize` hook
- All `useEffect` for drag transforms, placeholder, animation cancellation
- `prevPanePositionsRef` for distance-based duration (move to CSS or machine)

---

## 8. File Changes Summary

| Action | File |
|--------|------|
| Create | `packages/tmuxy-ui/src/machines/actors/tmuxActor.ts` |
| Create | `packages/tmuxy-ui/src/machines/actors/keyboardActor.ts` |
| Create | `packages/tmuxy-ui/src/machines/actors/animationActor.ts` |
| Create | `packages/tmuxy-ui/src/machines/actors/sizeActor.ts` |
| Delete | `packages/tmuxy-ui/src/machines/app/tmuxActor.ts` |
| Delete | `packages/tmuxy-ui/src/machines/keyboard/` (entire directory) |
| Delete | `packages/tmuxy-ui/src/hooks/useLayoutAnimation.ts` |
| Delete | `packages/tmuxy-ui/src/hooks/useGlobalMouseEvents.ts` |
| Delete | `packages/tmuxy-ui/src/hooks/useWindowResize.ts` |
| Delete | `packages/tmuxy-ui/src/hooks/useContainerSize.ts` |
| Delete | `packages/tmuxy-ui/src/hooks/useActivityTracker.ts` |
| Modify | `packages/tmuxy-ui/src/machines/app/appMachine.ts` |
| Modify | `packages/tmuxy-ui/src/machines/drag/dragMachine.ts` (spawn pointer listener, remove DOM access) |
| Modify | `packages/tmuxy-ui/src/machines/resize/resizeMachine.ts` (spawn pointer listener) |
| Modify | `packages/tmuxy-ui/src/components/PaneLayout.tsx` (simplify drastically) |
| Modify | `packages/tmuxy-ui/src/components/StatusBar.tsx` (remove prefix/command mode UI) |
| Modify | `packages/tmuxy-ui/src/machines/types.ts` (remove prefix/command types) |
| Modify | `CLAUDE.md` |
| Modify | `README.md` |

---

## 9. Providing Actors with Dependencies

```typescript
// AppContext.tsx
function AppProvider({ children }) {
  const [actor] = useState(() => {
    const adapter = createAdapter();
    return createActor(appMachine.provide({
      actors: {
        tmuxActor: createTmuxActor(adapter),
        keyboardActor: createKeyboardActor(),
        sizeActor: createSizeActor(measureCharSize),
        // animation actor spawned dynamically via SET_ANIMATION_ROOT event
      }
    }));
  });

  useEffect(() => { actor.start(); return () => actor.stop(); }, []);

  return <AppContext.Provider value={actor}>{children}</AppContext.Provider>;
}
```

---

## 10. Testing

```typescript
// Keyboard actor: verify keys are formatted and sent
test('formats arrow keys', () => {
  const parent = { send: vi.fn() };
  const actor = createActor(createKeyboardActor(), { input: { parent } });
  actor.start();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
  expect(parent.send).toHaveBeenCalledWith({
    type: 'SEND_TMUX_COMMAND', command: 'send-keys -t tmuxy Up'
  });
});

// Tmux actor: verify adapter is called
test('connects and fetches initial state', async () => {
  const adapter = { connect: vi.fn().mockResolvedValue(undefined), invoke: vi.fn(), ... };
  const actor = createActor(createTmuxActor(adapter));
  actor.start();
  expect(adapter.connect).toHaveBeenCalled();
});

// Animation actor: verify DOM manipulation
test('adds pane-leaving class', () => {
  const root = document.createElement('div');
  root.innerHTML = '<div data-pane-id="%0" class="pane-layout-item"></div>';
  const actor = createActor(createAnimationActor(root));
  actor.start();
  actor.send({ type: 'PANES_LEAVING', paneIds: ['%0'] });
  expect(root.querySelector('[data-pane-id="%0"]')!.classList.contains('pane-leaving')).toBe(true);
});

// Size actor: verify resize events
test('sends target size on window resize', () => {
  const parent = { send: vi.fn() };
  const measure = () => ({ charWidth: 8, charHeight: 20 });
  const actor = createActor(createSizeActor(measure), { input: { parent } });
  actor.start();
  expect(parent.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'SET_CHAR_SIZE' }));
});
```

---

## 11. Architecture Diagram

```
appMachine
├── Actors (fromCallback, injected via factory)
│   ├── createTmuxActor(adapter)       → WebSocket lifecycle, state updates
│   ├── createKeyboardActor()          → keydown → formatTmuxKey → send-keys
│   ├── createAnimationActor(rootEl)   → anime.js layout, drag transforms, enter/exit
│   └── createSizeActor(measureFn)     → window.resize, ResizeObserver, char measurement
│
├── Child Machines (stateful, no DOM access)
│   ├── dragMachine                    → idle/dragging, spawns pointer listener
│   └── resizeMachine                  → idle/resizing, spawns pointer listener
│
└── React Components (declarative, element-scoped handlers only)
    ├── PaneLayout    → renders positioned panes, no animation logic
    ├── PaneHeader    → onMouseDown → DRAG_START
    ├── ResizeDividers → onMouseDown → RESIZE_START
    ├── Terminal      → onWheel → debounced scroll commands
    ├── WindowTabs    → onClick → select window
    └── TmuxMenu      → useClickOutside (local, no machine)
```

---

## 12. CLAUDE.md / README.md Updates

### Architecture section:

> **Actors use factory functions** for dependency injection:
> `createXxxActor(dependency) => fromCallback(...)`. This decouples actors
> from global state, making them testable with mock dependencies. The machine
> provides actors at creation time via `.provide({ actors: { ... } })`.

> **Keyboard input is transparent.** The keyboard actor formats DOM keyboard
> events into tmux key syntax and sends them via `send-keys`. All key
> interpretation (prefix, bindings, command mode) is handled by tmux natively.
> The frontend does not reimplement tmux's keyboard logic.

> **All animations are imperative via the animation actor.** Components do not
> use animation hooks or direct DOM manipulation. The machine sends events
> to the animation actor, which uses anime.js to perform animations and
> reports completion back to the machine.

> **Machines have no DOM access.** State machines receive data through events
> and context — they never call `document.querySelector` or access the DOM
> directly. DOM interactions happen in actors (which own DOM subscriptions)
> or in React components (which own element-scoped handlers).

### Remove from guidelines:

> ~~Actors for async operations — Use XState actors for WebSocket connections, keyboard handling, and other async concerns.~~
> ~~`keyboardMachine` → key input modes (normal, prefix, command)~~

---

## 13. Anime.js API Reference (v4)

Key APIs used by the animation actor:

- `createLayout(root, params)` → `AutoLayout` instance
  - `params.children`: CSS selector for animated children
  - `params.enterFrom`: initial state for entering elements `{ opacity, scale, translateY }`
  - `params.leaveTo`: final state for leaving elements `{ opacity, scale, translateY }`
  - `params.duration`, `params.ease`
- `layout.record()` → capture current positions before DOM change
- `layout.animate()` → animate from recorded to current positions
- `layout.update(cb)` → record + cb + animate in one call
- `layout.revert()` → cleanup
- `animate(targets, params)` → imperative animation
  - Returns animation instance with `.pause()`, `.play()`, `.restart()`
  - `params.onComplete` callback

Docs: https://animejs.com/documentation/layout/

---

## 14. Additional Refactoring: Machine Composition Issues

### Problem 1: Module-level throttle state in resizeMachine

```typescript
// resizeMachine.ts — stored OUTSIDE the machine (module scope)
let lastSendTime = 0;
let pendingCommand: { ... } | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
```

This breaks if multiple machine instances exist, isn't testable, and isn't reset on machine stop. Move into context or use XState's `after` delays for throttling.

**Fix**: Use machine context for `lastSentDelta` (already there) and replace setTimeout throttling with XState's built-in `after` transition:

```typescript
resizing: {
  // XState handles the throttle delay natively
  states: {
    ready: {
      on: {
        RESIZE_MOVE: {
          target: 'throttled',
          actions: ['calculateAndSendResize'],
        },
      },
    },
    throttled: {
      after: { [THROTTLE_MS]: { target: 'ready' } },
      on: {
        RESIZE_MOVE: {
          // Buffer the latest move, apply when throttle expires
          actions: ['bufferResize'],
        },
      },
    },
  },
}
```

---

### Problem 2: Child machines duplicate parent state

Both `dragMachine` and `resizeMachine` maintain copies of `panes`, `charWidth`, `charHeight`:

```typescript
// dragMachine context
context: {
  panes: [],              // ← copy of parent's panes
  activePaneId: null,     // ← copy of parent's activePaneId
  charWidth: 9.6,         // ← copy of parent's charWidth
  charHeight: 20,         // ← copy of parent's charHeight
  drag: null,
}
```

Parent sends `UPDATE_PANES` and `UPDATE_CHAR_SIZE` to keep them in sync. This creates event traffic and risks stale data.

**Fix**: Pass required data as part of the triggering event, not as mirrored context:

```typescript
// Instead of mirroring:
DRAG_START: {
  paneId: string;
  startX: number;
  startY: number;
  // Include what the machine needs:
  panes: TmuxPane[];
  charWidth: number;
  charHeight: number;
  containerWidth: number;
  containerHeight: number;
}

DRAG_MOVE: {
  clientX: number;
  clientY: number;
  // Include latest state:
  panes: TmuxPane[];
  containerWidth: number;
  containerHeight: number;
}
```

This way the drag machine is **stateless about pane data** — it only stores drag-specific state (`DragState`). No sync events needed.

---

### Problem 3: `notifyStateUpdate` round-trip pattern

Both machines do `sendParent({ type: 'DRAG_STATE_UPDATE', drag: context.drag })` on every move. The parent stores this in its own context, creating a bidirectional sync loop:

```
Parent context.drag ← DRAG_STATE_UPDATE ← Child context.drag
```

Both hold the same `DragState` object, synced on every mouse move. This is wasteful.

**Fix**: The parent machine can read child machine state directly using XState's `useSelector` on the child actor ref. Or even simpler — the drag/resize machines can own their state entirely and the parent just reads it when needed:

```typescript
// In PaneLayout component:
const dragState = useSelector(appActor, (state) => {
  const dragRef = state.children.dragLogic;
  return dragRef?.getSnapshot()?.context.drag;
});
```

This eliminates `DRAG_STATE_UPDATE` and `RESIZE_STATE_UPDATE` events entirely. The child machine is the single source of truth for its own operation state.

**Alternative** (simpler): Keep the parent as source of truth, but make drag/resize machines truly stateless — they just compute and send commands. The parent tracks `DragState` / `ResizeState` in its own context, updated by actions in response to DRAG_MOVE / RESIZE_MOVE.

---

### Problem 4: Stack operations complexity

`appMachine` handles `STACK_ADD_PANE`, `STACK_SWITCH`, `STACK_CLOSE_PANE` with complex logic involving window lookups and compound tmux commands. This business logic clutters the machine definition.

**Fix**: Extract stack operations into pure functions called from actions:

```typescript
// machines/stacks.ts
export function getStackSwitchCommand(context: AppMachineContext, event: StackSwitchEvent): string | null {
  const stack = context.stacks[event.stackId];
  if (!stack) return null;
  const currentPaneId = stack.paneIds[stack.activeIndex];
  if (currentPaneId === event.paneId) return null;
  // ... window lookup logic
  return `swap-pane -s ${currentPaneId} -t ${event.paneId}`;
}

// In machine:
STACK_SWITCH: {
  actions: enqueueActions(({ context, event, enqueue }) => {
    const command = getStackSwitchCommand(context, event);
    if (command) enqueue(sendTo('tmux', { type: 'SEND_COMMAND', command }));
  }),
}
```

This makes the stack logic testable independently of the machine.

---

### Problem 5: Auto-resize sync in TMUX_STATE_UPDATE

The normal TMUX_STATE_UPDATE handler checks if tmux dimensions match target and sends `resize-window`:

```typescript
if (context.isPrimary && (transformed.totalWidth !== context.targetCols || ...)) {
  enqueue(sendTo('tmux', { type: 'SEND_COMMAND', command: `resize-window -x ... -y ...` }));
}
```

This is a side effect buried in a state update handler.

**Fix**: Move this to a guard + separate event, or handle it in the sizeActor by reacting to state changes. The sizeActor already knows the target size and can monitor for mismatches:

```typescript
// In sizeActor, listen for dimension mismatch:
// Parent sends DIMENSIONS_CHANGED when totalWidth/totalHeight updates
receive((event) => {
  if (event.type === 'DIMENSIONS_CHANGED') {
    if (event.totalWidth !== lastCols || event.totalHeight !== lastRows) {
      input.parent.send({ type: 'SEND_TMUX_COMMAND', command: `resize-window -x ${lastCols} -y ${lastRows}` });
    }
  }
});
```

---

### Problem 6: Consider merging drag + resize into one `interactionMachine`

Both machines are mutually exclusive (you can't drag and resize at the same time) and share the same patterns:
- idle/active states
- Pointer tracking (mousemove/mouseup)
- Escape cancellation
- Command throttling/batching
- `sendParent` for tmux commands

**Potential**: Merge into a single `interactionMachine` with states:

```
idle → dragging → idle
     → resizing → idle
```

**Pros**: Single pointer listener management, single escape handler, less event routing in parent
**Cons**: Larger machine, mixed concerns

**Verdict**: Keep separate. The logic inside DRAG_MOVE vs RESIZE_MOVE is different enough that merging would create a confusing machine. But extract shared patterns (pointer tracking, escape, command sending) into reusable actors/helpers.

---

### Problem 7: `SEND_TMUX_COMMAND` routing through parent

Both child machines and the keyboard actor all send `SEND_TMUX_COMMAND` to the parent, which forwards to the tmux actor. This creates a relay pattern:

```
keyboard → parent.SEND_TMUX_COMMAND → parent sends to tmux actor
dragMachine → parent.SEND_TMUX_COMMAND → parent sends to tmux actor
```

**Alternative**: Give child machines direct access to the tmux actor ref, so they can `sendTo('tmux', ...)` directly. But XState child machines can't directly reference sibling actors — only the parent can route.

**Verdict**: Keep the current relay pattern. It's explicit and the parent remains the single coordinator. The cost is one extra event hop, but the benefit is clear data flow and testability (child machines don't depend on sibling actors).

---

## 15. Summary: Refactoring Priority

| Priority | What | Impact | Effort |
|----------|------|--------|--------|
| 1 | Keyboard machine → simple actor | Removes 280 lines, simplifies mental model | Low |
| 2 | Animation actor (consolidate hook) | Single animation owner, testable | Medium |
| 3 | Size actor (consolidate resize hooks) | Removes 3 hooks, single size owner | Low |
| 4 | Remove DOM access from machines | Testable machines, clean separation | Low |
| 5 | Pointer listeners in drag/resize machines | Removes useGlobalMouseEvents hook | Low |
| 6 | Remove state mirroring in child machines | Less event traffic, simpler context | Medium |
| 7 | Module-level throttle → machine state | Correct lifecycle, testable | Low |
| 8 | Extract stack operations | Testable business logic | Low |
| 9 | Remove notifyStateUpdate round-trip | Less event traffic | Medium |
| 10 | Auto-resize into sizeActor | Cleaner TMUX_STATE_UPDATE handler | Low |
