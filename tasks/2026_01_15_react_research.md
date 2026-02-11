# React + Vite + Vitest Research for tmux-wrapper Project

## Overview
React is a JavaScript library for building user interfaces. Vite is a modern build tool that provides fast development server with Hot Module Replacement (HMR). Vitest is a next-generation testing framework designed to work seamlessly with Vite.

## Key Resources
- React Documentation: https://react.dev/
- Vite Documentation: https://vitejs.dev/
- Vitest Documentation: https://vitest.dev/
- React Testing Library: https://testing-library.com/docs/react-testing-library/intro/

## Vite + React Setup

### Why Vite?
- **Lightning Fast**: Uses native ES modules, no bundling in development
- **Hot Module Replacement**: Instant updates without full page reload
- **Optimized Builds**: Production builds use Rollup for optimal bundling
- **TypeScript Support**: First-class TypeScript support out of the box
- **Recommended by React Team**: Preferred over create-react-app

### Project Scaffolding
```bash
npm create vite@latest my-app -- --template react-ts
```

### Vite Configuration for Tauri
Key settings in `vite.config.ts`:
```typescript
export default defineConfig({
  // Prevents vite from obscuring rust errors
  clearScreen: false,
  server: {
    // Tauri expects port 1420 by default
    port: 1420,
    strictPort: true,
  },
  // Use TAURI_DEV_HOST for mobile development
  envPrefix: ['VITE_', 'TAURI_'],
})
```

### Directory Structure
```
src/
  ├── App.tsx          # Main component
  ├── App.css          # Styles
  ├── main.tsx         # Entry point
  └── components/      # React components
```

## React Fundamentals for Our Project

### Component Architecture
For tmux-wrapper, we need:

1. **App Component** (Root)
   - Manages Tauri IPC connections
   - Listens to tmux state events
   - Handles keyboard events

2. **Terminal Component**
   - Renders tmux pane content
   - Displays terminal output with proper formatting
   - Handles ANSI escape sequences (colors, formatting)

3. **Custom Hooks**
   - `useTauriEvent` - Listen to Tauri events
   - `useTauriCommand` - Invoke Tauri commands
   - `useKeyboardHandler` - Capture keyboard input

### State Management

#### useState
For local component state:
```typescript
const [terminalContent, setTerminalContent] = useState<string[]>([]);
const [cursorPosition, setCursorPosition] = useState({ x: 0, y: 0 });
```

#### useEffect
For side effects (setting up event listeners):
```typescript
useEffect(() => {
  const unlisten = listen('tmux-state-changed', (event) => {
    setTerminalContent(event.payload.content);
  });

  return () => {
    unlisten.then(fn => fn());
  };
}, []);
```

#### Context API (Optional)
If we need to share state across multiple components:
```typescript
const TmuxContext = createContext<TmuxState | null>(null);
```

For this simple project, local state should suffice.

### Event Handling

#### Keyboard Events
Critical for sending input to tmux:
```typescript
const handleKeyDown = (event: KeyboardEvent) => {
  event.preventDefault();

  // Convert key to tmux-compatible format
  const key = formatKeyForTmux(event);

  // Send to Tauri backend
  invoke('send_keys_to_tmux', { keys: key });
};

useEffect(() => {
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, []);
```

**Important Considerations:**
- Prevent default browser shortcuts (Ctrl+T, Ctrl+W, etc.)
- Handle special keys (Arrow keys, Ctrl combinations, Alt, etc.)
- Convert to tmux key format (e.g., Ctrl+A becomes `C-a`)

#### Focus Management
Ensure the app captures keyboard input:
```typescript
useEffect(() => {
  // Auto-focus on mount
  const element = document.getElementById('terminal');
  element?.focus();
}, []);
```

## Terminal Rendering

### Challenge
Render terminal content with:
- ANSI color codes
- Text formatting (bold, italic, underline)
- Cursor positioning
- Scrollback buffer

### Solution Options

#### Option 1: Simple Pre-formatted Text
```typescript
<pre style={{
  fontFamily: 'monospace',
  backgroundColor: '#000',
  color: '#fff',
  padding: '10px'
}}>
  {terminalContent.join('\n')}
</pre>
```

**Pros:** Simple, no dependencies
**Cons:** No ANSI support, no cursor

#### Option 2: ANSI to HTML Conversion
Use library like `ansi-to-html`:
```typescript
import Convert from 'ansi-to-html';

const convert = new Convert();
const html = convert.toHtml(terminalContent);

<div dangerouslySetInnerHTML={{ __html: html }} />
```

**Pros:** Handles colors and formatting
**Cons:** Security concerns with `dangerouslySetInnerHTML`, limited cursor support

#### Option 3: Full Terminal Emulator (Future Enhancement)
Libraries like `xterm.js` provide full terminal emulation but add complexity.

**For MVP:** Use Option 2 with sanitization

### Styling
```css
.terminal {
  font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.4;
  background-color: #1e1e1e;
  color: #d4d4d4;
  padding: 10px;
  overflow: auto;
  height: 100vh;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.terminal:focus {
  outline: none;
  border: 2px solid #007acc;
}
```

## Testing with Vitest

### Why Vitest?
- **Vite Integration**: Uses existing Vite config, no additional setup
- **Fast**: Leverages Vite's HMR for instant test runs
- **Jest Compatible**: Similar API to Jest, easy migration
- **Native ESM**: Works with modern JavaScript modules
- **TypeScript Support**: Works out of the box

### Setup

#### Install Dependencies
```bash
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

#### Configure Vitest
In `vite.config.ts`:
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
```

#### Setup File
Create `src/test/setup.ts`:
```typescript
import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

afterEach(() => {
  cleanup();
});
```

### Testing Strategy

#### 1. Component Tests
Test React components in isolation:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

describe('App', () => {
  it('renders terminal content', () => {
    render(<App />);
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
  });
});
```

#### 2. Mock Tauri IPC
```typescript
import { mockIPC } from '@tauri-apps/api/mocks';

// Mock commands
mockIPC((cmd, args) => {
  if (cmd === 'send_keys_to_tmux') {
    return Promise.resolve();
  }
  if (cmd === 'get_initial_state') {
    return Promise.resolve({
      content: ['line 1', 'line 2'],
      cursor: { x: 0, y: 0 }
    });
  }
});
```

#### 3. Simulate Events
```typescript
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';

it('updates terminal on tmux-state-changed event', async () => {
  render(<App />);

  // Simulate backend emitting event
  await emit('tmux-state-changed', {
    content: ['new content']
  });

  // Assert UI updated
  expect(screen.getByText('new content')).toBeInTheDocument();
});
```

#### 4. Test Keyboard Handling
```typescript
import { userEvent } from '@testing-library/user-event';

it('sends keys to backend on keyboard input', async () => {
  const user = userEvent.setup();
  const mockSendKeys = vi.fn();

  mockIPC((cmd, args) => {
    if (cmd === 'send_keys_to_tmux') {
      mockSendKeys(args);
      return Promise.resolve();
    }
  });

  render(<App />);

  await user.keyboard('hello');

  expect(mockSendKeys).toHaveBeenCalledWith({ keys: 'hello' });
});
```

### Running Tests
```bash
# Run tests
npm run test

# Run with UI
npm run test:ui

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### Best Practices

#### Query Priorities
React Testing Library recommends:
1. `getByRole` - Accessibility first
2. `getByLabelText` - Form elements
3. `getByPlaceholderText` - Form elements
4. `getByText` - Text content
5. `getByTestId` - Last resort

For our terminal, use `getByTestId` since it's a custom component:
```typescript
<div data-testid="terminal">...</div>
```

#### Avoid Testing Implementation Details
❌ **Bad:**
```typescript
expect(component.state.terminalContent).toBe('...');
```

✅ **Good:**
```typescript
expect(screen.getByTestId('terminal')).toHaveTextContent('...');
```

#### Async Testing
Always use `async/await` or `waitFor` when testing async behavior:
```typescript
import { waitFor } from '@testing-library/react';

await waitFor(() => {
  expect(screen.getByText('loaded')).toBeInTheDocument();
});
```

## TypeScript Integration

### Type Definitions
```typescript
// types/tmux.ts
export interface TmuxState {
  content: string[];
  cursor: {
    x: number;
    y: number;
  };
  width: number;
  height: number;
}

export interface TmuxEvent {
  type: 'state-changed' | 'error';
  payload: TmuxState | { error: string };
}
```

### Type-safe IPC
```typescript
import { invoke } from '@tauri-apps/api/core';

async function sendKeys(keys: string): Promise<void> {
  await invoke<void>('send_keys_to_tmux', { keys });
}

async function getInitialState(): Promise<TmuxState> {
  return await invoke<TmuxState>('get_initial_state');
}
```

## Performance Optimization

### Memoization
Prevent unnecessary re-renders:
```typescript
import { memo, useMemo } from 'react';

const Terminal = memo(({ content }: { content: string[] }) => {
  const renderedContent = useMemo(() => {
    return content.map((line, i) => <div key={i}>{line}</div>);
  }, [content]);

  return <div>{renderedContent}</div>;
});
```

### Debouncing Updates
If tmux sends updates frequently:
```typescript
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

const [content, setContent] = useState<string[]>([]);
const [pendingUpdate, setPendingUpdate] = useState<string[] | null>(null);

useEffect(() => {
  const timer = setTimeout(() => {
    if (pendingUpdate) {
      setContent(pendingUpdate);
      setPendingUpdate(null);
    }
  }, 16); // ~60fps

  return () => clearTimeout(timer);
}, [pendingUpdate]);
```

## Application to tmux-wrapper

### Component Structure
```
App.tsx
├── useTauriSetup()        # Initialize IPC connection
├── useTmuxEvents()        # Listen to state changes
├── useKeyboardHandler()   # Capture keyboard input
└── <Terminal />           # Render terminal content
    └── <TerminalLine />   # Individual line component
```

### Key Implementation Points
1. **Initialization**: Connect to Tauri backend on mount
2. **Event Listening**: Subscribe to tmux-state-changed events
3. **Keyboard Capture**: Capture all keyboard input and send to backend
4. **Terminal Rendering**: Display content with proper formatting
5. **Error Handling**: Display errors from backend
6. **Testing**: Mock all Tauri IPC for isolated component tests

### Development Workflow
1. Start Tauri dev server: `npm run tauri dev`
2. Make changes to React components
3. See instant updates via HMR
4. Run tests: `npm run test`
5. Build for production: `npm run tauri build`
