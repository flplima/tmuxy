import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { FilePicker, FilePickerButton } from './FilePicker';
import { ProviderHarness } from '../stories/StoryHarness';

interface MockEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
}

const TREE: Record<string, MockEntry[]> = {
  '/home/user': [
    { name: 'projects', path: '/home/user/projects', is_dir: true, is_symlink: false },
    { name: 'notes', path: '/home/user/notes', is_dir: true, is_symlink: false },
    { name: 'todo.md', path: '/home/user/todo.md', is_dir: false, is_symlink: false },
    { name: 'shell-rc', path: '/home/user/shell-rc', is_dir: false, is_symlink: true },
  ],
  '/home/user/projects': [
    { name: 'tmuxy', path: '/home/user/projects/tmuxy', is_dir: true, is_symlink: false },
    {
      name: 'experiments',
      path: '/home/user/projects/experiments',
      is_dir: true,
      is_symlink: false,
    },
    {
      name: 'README.md',
      path: '/home/user/projects/README.md',
      is_dir: false,
      is_symlink: false,
    },
  ],
  '/home/user/notes': [
    { name: 'meeting.md', path: '/home/user/notes/meeting.md', is_dir: false, is_symlink: false },
    { name: 'ideas.md', path: '/home/user/notes/ideas.md', is_dir: false, is_symlink: false },
  ],
};

/** Patch global fetch so /api/directory?path=… returns canned entries.
 *  Installed synchronously at module load — FilePicker's own useEffect
 *  fires on mount and would race a useEffect-installed mock.
 */
function installDirectoryMockOnce() {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __filePickerMockInstalled?: boolean };
  if (w.__filePickerMockInstalled) return;
  w.__filePickerMockInstalled = true;
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    if (url.includes('/api/directory')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      const entries = TREE[path];
      if (!entries) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      return new Response(JSON.stringify(entries), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return original(input, init);
  };
}

installDirectoryMockOnce();

const meta: Meta<typeof FilePicker> = {
  title: 'Components/FilePicker',
  component: FilePicker,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FilePicker>;

const Drawer = () => {
  const [open, setOpen] = useState(true);
  return (
    <ProviderHarness height={400}>
      <div style={{ position: 'relative', flex: 1 }}>
        <FilePickerButton onClick={() => setOpen((p) => !p)} isOpen={open} />
        <FilePicker isOpen={open} onClose={() => setOpen(false)} rootPath="/home/user" />
      </div>
    </ProviderHarness>
  );
};

export const Open: Story = {
  render: () => <Drawer />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Wait for the mocked /api/directory fetch to populate the entry list.
    await waitFor(
      () => {
        expect(canvas.getByText('projects')).toBeInTheDocument();
        expect(canvas.getByText('notes')).toBeInTheDocument();
        expect(canvas.getByText('todo.md')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  },
};

export const ButtonOnly: StoryObj<typeof FilePickerButton> = {
  render: () => (
    <ProviderHarness height={80}>
      <FilePickerButton onClick={() => {}} isOpen={false} />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The button is rendered with no specific role beyond <button>.
    const buttons = canvas.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  },
};
