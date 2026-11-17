import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { Modal } from './Modal';
import './menus/AppMenu.css';

const meta: Meta<typeof Modal> = {
  title: 'Components/Modal',
  component: Modal,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof Modal>;

const Demo = ({
  title,
  backdrop,
  hideHeader,
}: {
  title?: string;
  backdrop?: 'dim' | 'blur' | 'none';
  hideHeader?: boolean;
}) => {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ minHeight: '100vh', padding: 24 }}>
      <button onClick={() => setOpen(true)}>Reopen modal</button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        backdrop={backdrop}
        hideHeader={hideHeader}
        width={420}
      >
        <div style={{ padding: 20, color: 'var(--text-primary)' }}>
          <p>This is modal body content. Click outside, or hit ×.</p>
        </div>
      </Modal>
    </div>
  );
};

export const Titled: Story = {
  render: () => <Demo title="Confirm action" />,
  play: async () => {
    const body = within(document.body);
    expect(body.getByText('Confirm action')).toBeInTheDocument();
    const closeBtn = document.querySelector('.modal-close') as HTMLButtonElement | null;
    expect(closeBtn).not.toBeNull();

    await userEvent.click(closeBtn!);

    await waitFor(() => {
      expect(body.queryByText('Confirm action')).toBeNull();
    });

    // Reopen via the harness button to leave the visual state useful.
    await userEvent.click(body.getByRole('button', { name: /reopen modal/i }));
    await waitFor(() => {
      expect(body.getByText('Confirm action')).toBeInTheDocument();
    });
  },
};

export const Blur: Story = {
  render: () => <Demo title="Blurred backdrop" backdrop="blur" />,
  play: async () => {
    const body = within(document.body);
    expect(body.getByText('Blurred backdrop')).toBeInTheDocument();
    const backdrop = document.querySelector('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.classList.contains('modal-backdrop-blur')).toBe(true);
  },
};

export const HeaderHidden: Story = {
  render: () => <Demo hideHeader />,
  play: async () => {
    expect(document.querySelector('.modal-close')).toBeNull();
    expect(document.querySelector('.modal-container')).not.toBeNull();
    expect(document.querySelector('.modal-header')).toBeNull();
  },
};

const Dialog = () => (
  <Modal open title="Close Pane" width={380} onClose={() => {}}>
    <div data-testid="dialog">
      <p className="app-menu-dialog-text">Close this pane?</p>
      <div className="app-menu-dialog-actions">
        <button type="button">Cancel</button>
        <button type="button" className="is-destructive">
          Close Pane
        </button>
      </div>
    </div>
  </Modal>
);

/** Escape dismisses a dialog, even with the focus outside it, and the key goes no further. */
export const EscapeClosesADialog: Story = {
  render: () => <Demo title="Copy Trace" />,
  play: async () => {
    const body = within(document.body);
    expect(body.getByText('Copy Trace')).toBeInTheDocument();
    let reachedWindow = false;
    const behind = (event: KeyboardEvent) => {
      if (event.key === 'Escape') reachedWindow = true;
    };
    window.addEventListener('keydown', behind);
    try {
      (document.activeElement as HTMLElement | null)?.blur();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(body.queryByText('Copy Trace')).toBeNull());
      expect(reachedWindow).toBe(false);
    } finally {
      window.removeEventListener('keydown', behind);
    }
  },
};

const root = document.documentElement;

/** A dialog sits in the middle of the window both ways, in the terminal's font. */
export const DialogCentredMonospaced: Story = {
  render: () => <Dialog />,
  play: async () => {
    const box = document.querySelector('.modal-container') as HTMLElement;
    await waitFor(() => expect(box.getBoundingClientRect().width).toBeGreaterThan(100));
    const rect = box.getBoundingClientRect();
    expect(Math.abs(rect.left + rect.width / 2 - innerWidth / 2)).toBeLessThan(3);
    expect(Math.abs(rect.top + rect.height / 2 - innerHeight / 2)).toBeLessThan(3);
    const unquoted = (family: string) => family.replace(/['"]/g, '');
    const mono = unquoted(getComputedStyle(root).getPropertyValue('--font-mono').trim());
    expect(unquoted(getComputedStyle(box).fontFamily)).toBe(mono);
    const answer = box.querySelector('.app-menu-dialog-actions button')!;
    expect(unquoted(getComputedStyle(answer).fontFamily)).toBe(mono);
  },
};

/** The colour scheme's own variables paint it, so a light face repaints it. */
export const DialogFollowsTheScheme: Story = {
  render: () => <Dialog />,
  play: async () => {
    const box = document.querySelector('.modal-container') as HTMLElement;
    const cancel = box.querySelector('.app-menu-dialog-actions button') as HTMLElement;
    const light = {
      '--bg-black': 'rgb(250, 250, 250)',
      '--text-primary': 'rgb(20, 20, 20)',
      '--border-light': 'rgb(200, 0, 0)',
      '--bg-medium': 'rgb(230, 230, 230)',
    };
    try {
      for (const [name, value] of Object.entries(light)) root.style.setProperty(name, value);
      await waitFor(() => {
        const style = getComputedStyle(box);
        expect(style.backgroundColor).toBe(light['--bg-black']);
        expect(style.color).toBe(light['--text-primary']);
        expect(style.borderTopColor).toBe(light['--border-light']);
        expect(getComputedStyle(cancel).backgroundColor).toBe(light['--bg-medium']);
      });
    } finally {
      for (const name of Object.keys(light)) root.style.removeProperty(name);
    }
  },
};
