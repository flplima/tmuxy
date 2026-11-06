import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { FloatingMenu, MenuItem, SubMenu } from '../Menu';

// Animations on, so a closed submenu is held in the DOM for its exit.
vi.mock('../../../machines/appHooks', () => ({ useAppSelector: () => true }));

// jsdom has no Web Animations; the menu only asks which are playing.
Element.prototype.getAnimations ??= () => [];

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

    // Real browser timing from here on: React commits the submenu in one task and
    // runs its effects in a later one, and keys can land in between.
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    const theme = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Theme'),
    )!;
    const column = appearance('[role="menu"][aria-label="Theme"]');
    theme.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    const submenu = await column;

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
