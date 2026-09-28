/**
 * The menu primitive (components/floating/Menu).
 *
 * Every menu in tmuxy is built from these pieces, so what is covered here is
 * the PRIMITIVE rather than any one menu: the roles a screen reader reads, the
 * keyboard, submenus, the single-surface rule, and the ways a menu is
 * dismissed. The menus themselves have their own stories for what is in them.
 */

import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { FloatingMenu, MenuItem, MenuDivider, MenuHeader, MenuRadioGroup, SubMenu } from './Menu';
import { ProviderHarness } from '../../stories/StoryHarness';

const meta: Meta = {
  title: 'Components/FloatingMenu',
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj;

/** Everything the primitive can draw, hung off a button. */
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
    <div style={{ height: 320 }}>
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
 * A menu asked for at the bottom-right corner of the window, the way a
 * right-click there produces one. The point is read from the live viewport, so
 * the story is about the placement rule rather than about the story's layout.
 */
function CornerMenuHarness() {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  return (
    <div style={{ height: 320 }}>
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

/** Open the harness's menu and wait until it is really drawn. */
async function openMenu(canvas: ReturnType<typeof within>, name = /open menu/i) {
  await userEvent.click(await canvas.findByRole('button', { name }));
  return waitFor(() => {
    const el = menu();
    expect(el, 'no menu').not.toBeNull();
    expect(el!.getBoundingClientRect().height).toBeGreaterThan(0);
    return el!;
  });
}

/**
 * The shape a screen reader is handed, and the shape every test in the repo
 * queries by: a `menu` of `menuitem`s, with the two stateful kinds announcing
 * what they are and whether they are on.
 */
export const RolesAndStates: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <MenuHarness />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await openMenu(canvas);
    const body = within(document.body);

    expect(panel.getAttribute('role')).toBe('menu');
    expect(body.getByRole('menuitem', { name: 'First' })).toBeInTheDocument();

    // Disabled is announced, not merely drawn dim — and it is skipped by the
    // keyboard (see the navigation story).
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

    // A submenu says it opens one, which is what the ▶ means visually.
    const more = body.getByRole('menuitem', { name: 'More' });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    expect(more).toHaveAttribute('aria-expanded', 'false');
  },
};

/**
 * The keyboard. A menu that only answers the mouse is not usable without one,
 * and the surface takes focus when it opens precisely so these keys land here
 * rather than in the terminal behind it.
 */
export const KeyboardNavigation: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <MenuHarness />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openMenu(canvas);
    const body = within(document.body);

    // Opening puts the cursor on the first item, so the next key is a move
    // rather than an aim.
    await waitFor(() =>
      expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'First' })),
    );

    // Down skips what cannot be chosen.
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'Second' }));

    // Up comes back past it the same way, and wraps at the ends.
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'First' }));
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'More' }));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'First' }));

    // Enter chooses what the cursor is on, and choosing closes the menu.
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(canvas.getByTestId('chosen')).toHaveTextContent('second'));
    await waitFor(() => expect(menu()).toBeNull());
  },
};

/** Escape is the way out that changes nothing. */
export const EscapeCloses: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <MenuHarness />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openMenu(canvas);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(menu()).toBeNull());
    expect(canvas.getByTestId('chosen')).toHaveTextContent('');
  },
};

/** A press anywhere else puts it away — including on the button that opened
 *  it, which toggles rather than closing and reopening in one gesture. */
export const PressingOutsideCloses: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <MenuHarness />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openMenu(canvas);

    await userEvent.click(canvas.getByTestId('chosen'));
    await waitFor(() => expect(menu()).toBeNull());

    // And the button still opens it again afterwards.
    await openMenu(canvas);
    await userEvent.click(canvas.getByRole('button', { name: /open menu/i }));
    await waitFor(() => expect(menu()).toBeNull());
  },
};

/**
 * A submenu is a column of its own beside the item that opens it — a child of
 * the menu rather than a peer, so opening one does NOT put its parent away.
 */
export const SubmenuOpensBesideItsItem: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <MenuHarness />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const parent = await openMenu(canvas);
    const body = within(document.body);

    const more = body.getByRole('menuitem', { name: 'More' });
    await userEvent.click(more);

    // Both columns are up: the parent did not go away for its own child.
    await waitFor(() => expect(panels().length).toBe(2));
    expect(more).toHaveAttribute('aria-expanded', 'true');

    const child = panels().find((p) => p !== parent)!;
    const parentBox = parent.getBoundingClientRect();
    const childBox = child.getBoundingClientRect();
    // Beside, not under: a submenu that dropped below its item would cover the
    // rest of the menu it belongs to.
    expect(childBox.left).toBeGreaterThanOrEqual(parentBox.left);
    expect(childBox.top).toBeLessThan(parentBox.bottom);
    // The item says what it opened, which is what the keyboard follows.
    expect(more.getAttribute('aria-controls')).toBe(child.id);

    // Right moves the cursor into the column, left folds it away and hands the
    // cursor back to the item that opened it, and right opens it again. A
    // submenu only the mouse can reach is a branch of the menu the keyboard
    // cannot see.
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() =>
      expect(document.activeElement).toBe(body.getByRole('menuitem', { name: 'Nested' })),
    );
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(panels().length).toBe(1));
    expect(document.activeElement).toBe(more);
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(panels().length).toBe(2));

    // Choosing in the child closes the whole thing, not just the column.
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByTestId('chosen')).toHaveTextContent('nested'));
    await waitFor(() => expect(panels().length).toBe(0));
  },
};

/** Two menus, one layer: opening the second puts the first away by itself. */
export const OnlyOneSurfaceAtATime: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <div style={{ display: 'flex', gap: 24 }}>
        <MenuHarness label="Left menu" />
        <MenuHarness label="Right menu" />
      </div>
    </ProviderHarness>
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

/**
 * Where it goes. Right-clicked near the bottom-right corner — the selection
 * menu's daily case — a menu opens UPWARDS and to the left rather than off the
 * screen. One placement rule serves a menu bar at the top and a context menu
 * at the very edge, because it measures the surface before it clamps it.
 */
export const StaysInsideTheWindow: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <CornerMenuHarness />
    </ProviderHarness>
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

    // Flipped above the point it was asked for, since there was no room under
    // it — the menu is beside the corner rather than through it.
    const point = JSON.parse(canvas.getByTestId('point').textContent ?? '{}');
    expect(box.bottom).toBeLessThanOrEqual(point.y + 1);
  },
};
