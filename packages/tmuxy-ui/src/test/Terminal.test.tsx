import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Terminal } from '../components/Terminal';

// Mock functions
const mockWrite = vi.fn();
const mockClear = vi.fn();
const mockOpen = vi.fn();
const mockDispose = vi.fn();
const mockGetSelection = vi.fn();
const mockLoadAddon = vi.fn();
const mockFit = vi.fn();

// Mock xterm.js
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    write = mockWrite;
    clear = mockClear;
    open = mockOpen;
    dispose = mockDispose;
    getSelection = mockGetSelection;
    loadAddon = mockLoadAddon;
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = mockFit;
  },
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}));

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('mocked history'),
}));

describe('Terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders terminal container', () => {
    const content = ['line 1', 'line 2', 'line 3'];
    render(<Terminal content={content} />);

    const terminal = screen.getByTestId('terminal');
    expect(terminal).toBeInTheDocument();
    expect(terminal).toHaveClass('terminal-container');
  });

  it('initializes xterm.js on mount', () => {
    render(<Terminal content={['test']} />);

    // Check that xterm was opened
    expect(mockOpen).toHaveBeenCalled();
    expect(mockLoadAddon).toHaveBeenCalledTimes(2); // FitAddon and WebLinksAddon
  });

  it('writes content to terminal', () => {
    const content = ['line 1', 'line 2', 'line 3'];
    render(<Terminal content={content} />);

    // Should clear and write content
    expect(mockClear).toHaveBeenCalled();
    expect(mockWrite).toHaveBeenCalledWith('line 1\r\nline 2\r\nline 3');
  });

  it('handles empty content', () => {
    render(<Terminal content={[]} />);

    expect(mockClear).toHaveBeenCalled();
    expect(mockWrite).toHaveBeenCalledWith('');
  });

  it('updates terminal when content changes', () => {
    const { rerender } = render(<Terminal content={['initial']} />);

    // Clear mocks after initial render
    mockClear.mockClear();
    mockWrite.mockClear();

    // Update content
    rerender(<Terminal content={['updated', 'content']} />);

    expect(mockClear).toHaveBeenCalled();
    expect(mockWrite).toHaveBeenCalledWith('updated\r\ncontent');
  });

  it('cleans up on unmount', () => {
    const { unmount } = render(<Terminal content={['test']} />);

    unmount();

    expect(mockDispose).toHaveBeenCalled();
  });
});
