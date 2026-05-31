import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { Modal } from './Modal';

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
  closeOnBackdrop = true,
}: {
  title?: string;
  backdrop?: 'dim' | 'blur' | 'none';
  hideHeader?: boolean;
  closeOnBackdrop?: boolean;
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
        closeOnBackdrop={closeOnBackdrop}
        width={420}
      >
        <div style={{ padding: 20, color: 'var(--text-default)' }}>
          <p>This is modal body content. Press Esc, click outside, or hit ×.</p>
        </div>
      </Modal>
    </div>
  );
};

export const Titled: Story = {
  render: () => <Demo title="Confirm action" />,
  play: async () => {
    // Modal renders into document.body via a portal, so query from there.
    const body = within(document.body);
    expect(body.getByText('Confirm action')).toBeInTheDocument();
    // The close button's accessible name is its text content "×".
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
    // Backdrop must use the blur class so the CSS variant kicks in.
    const backdrop = document.querySelector('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.classList.contains('modal-backdrop-blur')).toBe(true);
  },
};

export const HeaderHidden: Story = {
  render: () => <Demo hideHeader />,
  play: async () => {
    // No title, no close button, but the modal container is still in the DOM.
    expect(document.querySelector('.modal-close')).toBeNull();
    expect(document.querySelector('.modal-container')).not.toBeNull();
    expect(document.querySelector('.modal-header')).toBeNull();
  },
};

export const StickyBackdrop: Story = {
  render: () => <Demo title="Click outside is ignored" closeOnBackdrop={false} />,
  parameters: {
    docs: {
      description: {
        story: 'closeOnBackdrop=false keeps the modal open even if the user clicks the dim layer.',
      },
    },
  },
  play: async () => {
    const body = within(document.body);
    expect(body.getByText('Click outside is ignored')).toBeInTheDocument();

    const backdrop = document.querySelector('.modal-backdrop') as HTMLElement | null;
    expect(backdrop).not.toBeNull();
    await userEvent.click(backdrop!);

    // After a click, the modal must STILL be open.
    expect(body.getByText('Click outside is ignored')).toBeInTheDocument();
  },
};
