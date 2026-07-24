import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../machines/AppContext', () => ({
  useAppSelector: (selector: (context: { reconnectAttempt: number }) => unknown) =>
    selector({ reconnectAttempt: 0 }),
  useAppState: () => false,
}));
vi.mock('../../tmux/adapters', () => ({ isTauri: () => false }));
vi.mock('../../utils/renderLog', () => ({
  LogProfiler: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../WindowTabs', () => ({ WindowTabs: () => <div data-testid="window-tabs" /> }));
vi.mock('../SidebarToggle', () => ({
  SidebarToggle: () => <button aria-label="Toggle sidebar" />,
}));
vi.mock('../menus/AppMenu', () => ({
  AppMenu: () => <button className="app-menu-button" aria-label="Menu" />,
}));

import { StatusBar } from '../StatusBar';

describe('StatusBar layout ownership', () => {
  it('does not constrain global navigation to the mutable terminal-grid width', () => {
    const { container } = render(<StatusBar />);
    const inner = container.querySelector('.statusbar-inner');

    expect(inner).not.toBeNull();
    expect(inner).not.toHaveAttribute('style');
  });
});
