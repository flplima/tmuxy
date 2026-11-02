import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { FloatingMenu, MenuItem, SubMenu } from '../Menu';

// The menu reads one thing from the app: whether animations are allowed. On,
// so a closed submenu is held in the DOM for its exit, as it is in the app.
vi.mock('../../../machines/appHooks', () => ({ useAppSelector: () => true }));

// jsdom has no Web Animations; the menu only asks which are playing.
Element.prototype.getAnimations ??= () => [];

/** Resolves on the first DOM change that puts `selector` on the page. */
function appearance(selector: string): Promise<HTMLElement> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const found = document.querySelector<HTMLElement>(selector);
      if (!found) return;
      observer.disconnect();
      resolve(found);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

const press = (key: string) =>
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe('a submenu opened by hovering its item', () => {
  afterEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('closes one level per Escape even when the keys arrive before React has idled', async () => {
    const onClose = vi.fn();
    render(
      <FloatingMenu id="menu" anchor={{ kind: 'point', x: 0, y: 0 }} onClose={onClose}>
        <MenuItem>New Tab</MenuItem>
        <SubMenu label="Theme">
          <MenuItem>Dark Mode</MenuItem>
          <MenuItem disabled>Gruvbox</MenuItem>
        </SubMenu>
      </FloatingMenu>,
    );

    // Real browser timing from here on: a hover is not a discrete event, so
    // React commits the submenu in one task and runs its effects in a later
    // one — and keys can land in between, the way a fast keyboard (or a
    // loaded CI runner) delivers them.
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    const theme = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Theme'),
    )!;
    const column = appearance('[role="menu"][aria-label="Theme"]');
    theme.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    const submenu = await column;

    // Inside the column the moment it is on screen, then Escape twice: out of
    // the submenu, then out of the menu.
    [...submenu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.includes('Gruvbox'))!
      .focus();
    press('Escape');
    await settle();
    expect(document.activeElement).toBe(theme);
    press('Escape');
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
