import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewWidgetLoader } from '../PreviewWidgetLoader';
import { pid } from '../../../../test/wire';

// The widget's chunk is gone (a server updated under an open page): its
// import rejects, as a 404 for the old file makes it.
vi.mock('../PreviewWidget', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

describe('the preview widget, loaded late', () => {
  it('says only in its own pane that it could not load, and offers a reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <div data-testid="terminal">the terminal goes on</div>
        <PreviewWidgetLoader paneId={pid('%3')} lines={['README.md']} />
      </div>,
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload to show it' })).toBeTruthy();
    expect(screen.getByTestId('terminal').textContent).toBe('the terminal goes on');
  });
});
