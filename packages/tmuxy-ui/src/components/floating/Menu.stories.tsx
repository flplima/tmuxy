import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { FloatingMenu, MenuItem, MenuDivider, MenuHeader, MenuRadioGroup, SubMenu } from './Menu';
import { FixtureProvider } from '../../stories/FixtureHarness';
import { asFixture } from '../../stories/fixtures/FixtureAdapter';
import panes from '../../stories/fixtures/gen/panes.json';

const PANES = asFixture(panes);

const meta: Meta = {
  title: 'Components/FloatingMenu',
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj;

function MenuHarness({
  onChoose,
  label = 'Open menu',
}: {
  onChoose?: (what: string) => void;
  label?: string;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState('');
  const [blink, setBlink] = useState(false);
  const [level, setLevel] = useState('shape');

  const choose = (what: string) => {
    setChosen(what);
    onChoose?.(what);
  };

  return (
    <div style={{ height: 320, color: 'var(--text-primary)' }}>
      <button ref={buttonRef} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      <div data-testid="chosen">{chosen}</div>
      <div data-testid="blink">{String(blink)}</div>
      <div data-testid="level">{level}</div>
      {open && (
        <FloatingMenu
          id={`story-menu-${label}`}
          label={label}
          anchor={{ kind: 'element', element: buttonRef.current }}
          onClose={() => setOpen(false)}
          ignoreRef={buttonRef}
        >
          <MenuHeader>Section</MenuHeader>
          <MenuItem onClick={() => choose('first')}>First</MenuItem>
          <MenuItem disabled onClick={() => choose('unreachable')}>
            Unavailable
          </MenuItem>
          <MenuItem onClick={() => choose('second')}>Second</MenuItem>
          <MenuDivider />
          <MenuItem type="checkbox" checked={blink} onClick={(e) => setBlink(e.checked)}>
            Blinking
          </MenuItem>
          <MenuRadioGroup value={level} onRadioChange={(e) => setLevel(e.value)}>
            <MenuItem type="radio" value="shape">
              Shape
            </MenuItem>
            <MenuItem type="radio" value="full">
              Full
            </MenuItem>
          </MenuRadioGroup>
          <MenuDivider />
          <SubMenu label="More">
            <MenuItem onClick={() => choose('nested')}>Nested</MenuItem>
          </SubMenu>
        </FloatingMenu>
      )}
    </div>
  );
}

/**
 * The point is read from the live viewport, so the story tests the placement
 * rule, not its own layout.
 */
function CornerMenuHarness() {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  return (
    <div style={{ height: 320, color: 'var(--text-primary)' }}>
      <button onClick={() => setPoint({ x: window.innerWidth - 4, y: window.innerHeight - 4 })}>
        Open at the corner
      </button>
      <div data-testid="point">{JSON.stringify(point)}</div>
      {point && (
        <FloatingMenu
          id="story-corner-menu"
          label="Corner"
          anchor={{ kind: 'point', x: point.x, y: point.y }}
          onClose={() => setPoint(null)}
        >
          <MenuItem onClick={() => setPoint(null)}>Copy</MenuItem>
          <MenuItem onClick={() => setPoint(null)}>Send keys</MenuItem>
        </FloatingMenu>
      )}
    </div>
  );
}

const menu = () => document.querySelector<HTMLElement>('.floating-menu');
const panels = () => [...document.querySelectorAll<HTMLElement>('.floating-menu')];

async function openMenu(canvas: ReturnType<typeof within>, name = /open menu/i) {
  await userEvent.click(await canvas.findByRole('button', { name }));
  return waitFor(() => {
    const el = menu();
    expect(el, 'no menu').not.toBeNull();
    expect(el!.getBoundingClientRect().height).toBeGreaterThan(0);
    return el!;
  });
}

/** The roles a screen reader is handed, and every test in the repo queries by. */
export const RolesAndStates: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <MenuHarness />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await openMenu(canvas);
    const body = within(document.body);

    expect(panel.getAttribute('role')).toBe('menu');
    expect(body.getByRole('menuitem', { name: 'First' })).toBeInTheDocument();

    expect(body.getByRole('menuitem', { name: 'Unavailable' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(body.getByRole('menuitem', { name: 'First' })).not.toHaveAttribute('aria-disabled');

    const check = body.getByRole('menuitemcheckbox', { name: 'Blinking' });
    expect(check).toHaveAttribute('aria-checked', 'false');
    expect(body.getByRole('menuitemradio', { name: 'Shape' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(body.getByRole('menuitemradio', { name: 'Full' })).toHaveAttribute(
      'aria-checked',
      'false',
    );

    const more = body.getByRole('menuitem', { name: 'More' });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    expect(more).toHaveAttribute('aria-expanded', 'false');
  },
};

export const KeyboardNavigation: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <MenuHarness />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openMenu(canvas);
    const body = within(document.body);

    await waitFor(() =>
      expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'First' })),
    );

    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'Second' }));

    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'First' }));
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'More' }));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'First' }));

    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(canvas.getByTestId('chosen')).toHaveTextContent('second'));
    await waitFor(() => expect(menu()).toBeNull());
  },
};

export const EscapeCloses: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <MenuHarness />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openMenu(canvas);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(menu()).toBeNull());
    expect(canvas.getByTestId('chosen')).toHaveTextContent('');
  },
};

/** A press on the button that opened the menu toggles it shut rather than closing and reopening. */
export const PressingOutsideCloses: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <MenuHarness />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openMenu(canvas);

    await userEvent.click(canvas.getByTestId('chosen'));
    await waitFor(() => expect(menu()).toBeNull());

    await openMenu(canvas);
    await userEvent.click(canvas.getByRole('button', { name: /open menu/i }));
    await waitFor(() => expect(menu()).toBeNull());
  },
};

export const SubmenuOpensBesideItsItem: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <MenuHarness />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const parent = await openMenu(canvas);
    const body = within(document.body);

    const more = body.getByRole('menuitem', { name: 'More' });
    await userEvent.click(more);

    await waitFor(() => expect(panels().length).toBe(2));
    expect(more).toHaveAttribute('aria-expanded', 'true');

    const child = panels().find((p) => p !== parent)!;
    const parentBox = parent.getBoundingClientRect();
    const childBox = child.getBoundingClientRect();
    expect(childBox.left).toBeGreaterThanOrEqual(parentBox.left);
    expect(childBox.top).toBeLessThan(parentBox.bottom);
    expect(more.getAttribute('aria-controls')).toBe(child.id);

    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() =>
      expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'Nested' })),
    );
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(panels().length).toBe(1));
    expect(document.activeElement).toBe(more);
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(panels().length).toBe(2));

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByTestId('chosen')).toHaveTextContent('nested'));
    await waitFor(() => expect(panels().length).toBe(0));
  },
};

export const OnlyOneSurfaceAtATime: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <div style={{ display: 'flex', gap: 24 }}>
        <MenuHarness label="Left menu" />
        <MenuHarness label="Right menu" />
      </div>
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openMenu(canvas, /left menu/i);
    expect(panels().length).toBe(1);
    expect(menu()?.getAttribute('aria-label')).toBe('Left menu');

    await userEvent.click(canvas.getByRole('button', { name: /right menu/i }));
    await waitFor(() => {
      const open = panels();
      expect(open.length, 'two menus were up at once').toBe(1);
      expect(open[0].getAttribute('aria-label')).toBe('Right menu');
    });
  },
};

export const StaysInsideTheWindow: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <CornerMenuHarness />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /open at the corner/i }));
    const panel = await waitFor(() => {
      const el = menu();
      expect(el, 'no menu').not.toBeNull();
      expect(el!.getBoundingClientRect().height).toBeGreaterThan(0);
      return el!;
    });

    const box = panel.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);

    const point = JSON.parse(canvas.getByTestId('point').textContent ?? '{}');
    expect(box.bottom).toBeLessThanOrEqual(point.y + 1);
  },
};
