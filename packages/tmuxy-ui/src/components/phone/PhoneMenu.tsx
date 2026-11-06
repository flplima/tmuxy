/**
 * PhoneMenu — the app menu as a phone app shows one: a full-width list in
 * the bottom view (PhoneBottomView), its items the hamburger's own
 * (`appMenuSpec` in components/menus/specs, dispatched by
 * `useAppMenuSurface`, so an item does here
 * what it does on a desktop). A submenu is a row with a chevron that goes to
 * a page listing its children, with a back button at the top that returns
 * to the page before (`domain/menus/menuPages.ts`). A page comes in from the
 * side it is walked toward, over the theme's normal transition, and in one
 * step with animations off.
 *
 * Checkboxes and radio options are rows with a check mark on the chosen
 * ones; a choice leaves the page where it is, so the mark is seen to move.
 * Key hints are left out: a phone has no keys to press them on.
 */

import { memo, useState } from 'react';
import { useAppSelector } from '../../machines/appHooks';
import { menuPages } from '../../domain/menus/menuPages';
import { appMenuSpec } from '../menus/specs/appMenu';
import type { AppMenuNode } from '../menus/specs/actions';
import { MenuIcon } from '../menus/MenuIcons';
import { dataAttributes, type AppMenuDispatch } from '../menus/SpecMenu';
import { useMenuEnv } from '../menus/menuEnv';
import { useAppMenuSurface } from '../menus/useAppMenuSurface';
import './PhoneMenu.css';

type Direction = 'forward' | 'back';

function Check({ on }: { on: boolean }) {
  return (
    <svg
      className="phone-menu-check"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ visibility: on ? 'visible' : 'hidden' }}
    >
      <path d="M3 8.5l3.2 3L13 4.5" />
    </svg>
  );
}

function Chevron({ back = false }: { back?: boolean }) {
  return (
    <svg
      className="phone-menu-chevron"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={back ? 'M10 3L5 8l5 5' : 'M6 3l5 5-5 5'} />
    </svg>
  );
}

function Row({
  node,
  dispatch,
  open,
}: {
  node: AppMenuNode;
  dispatch: AppMenuDispatch;
  open: (id: string) => void;
}) {
  switch (node.kind) {
    case 'separator':
      return <div className="phone-menu-gap" role="separator" />;
    case 'header':
      return <div className="phone-menu-header">{node.label}</div>;
    case 'predefined':
      return null;
    case 'submenu':
      return (
        <button
          type="button"
          className="phone-menu-row"
          role="menuitem"
          aria-haspopup="menu"
          data-menu-id={node.id}
          disabled={node.disabled}
          onClick={() => {
            if (node.onOpen) dispatch(node.onOpen);
            open(node.id);
          }}
        >
          <span className="phone-menu-label">{node.label}</span>
          <Chevron />
        </button>
      );
    case 'item':
      return (
        <button
          type="button"
          className={`phone-menu-row${node.className ? ` ${node.className}` : ''}`}
          role="menuitem"
          data-menu-id={node.id}
          data-testid={node.testId}
          {...dataAttributes(node.data)}
          disabled={node.disabled}
          onClick={() => dispatch(node.action)}
        >
          {node.icon && <MenuIcon name={node.icon} />}
          <span className="phone-menu-label">{node.label}</span>
        </button>
      );
    case 'checkbox':
      return (
        <button
          type="button"
          className={`phone-menu-row${node.className ? ` ${node.className}` : ''}`}
          role="menuitemcheckbox"
          aria-checked={node.checked}
          data-menu-id={node.id}
          data-testid={node.testId}
          {...dataAttributes(node.data)}
          disabled={node.disabled}
          onClick={() => dispatch(node.action)}
        >
          <span className="phone-menu-label">{node.label}</span>
          <Check on={node.checked} />
        </button>
      );
    case 'radio-group':
      return (
        <div role="group" data-menu-id={node.id}>
          {node.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="phone-menu-row"
              role="menuitemradio"
              aria-checked={option.value === node.value}
              data-menu-id={`${node.id}:${option.value}`}
              disabled={option.disabled}
              onClick={() => dispatch(option.action)}
            >
              <span className="phone-menu-label">{option.label}</span>
              <Check on={option.value === node.value} />
            </button>
          ))}
        </div>
      );
  }
}

export const PhoneMenu = memo(function PhoneMenu() {
  const env = useMenuEnv();
  const { dispatch, options, dialogs } = useAppMenuSurface(env);
  const spec = useAppSelector((ctx) => appMenuSpec(ctx, env, options));
  const [path, setPath] = useState<string[]>([]);
  const [direction, setDirection] = useState<Direction | null>(null);

  const pages = menuPages(spec, path);
  const page = pages[pages.length - 1];
  const parent = pages.length > 1 ? pages[pages.length - 2] : null;
  const walked = pages.slice(1).map((p) => p.id as string);

  const open = (id: string) => {
    setDirection('forward');
    setPath([...walked, id]);
  };
  const back = () => {
    setDirection('back');
    setPath(walked.slice(0, -1));
  };

  return (
    <div className="phone-menu" data-testid="phone-menu">
      <div className="phone-menu-bar">
        {parent && (
          <button
            type="button"
            className="phone-menu-back"
            aria-label={`Back to ${parent.title ?? 'Menu'}`}
            onClick={back}
          >
            <Chevron back />
            <span>{parent.title ?? 'Menu'}</span>
          </button>
        )}
        <span className="phone-menu-title">{page.title ?? 'Menu'}</span>
      </div>
      <div
        key={walked.join('/')}
        className="phone-menu-page"
        role="menu"
        aria-label={page.title ?? 'Menu'}
        data-direction={direction ?? undefined}
        data-depth={walked.length}
      >
        {page.nodes.map((node, i) => (
          <Row
            key={'id' in node ? node.id : `${node.kind}-${i}`}
            node={node}
            dispatch={dispatch}
            open={open}
          />
        ))}
      </div>
      {dialogs}
    </div>
  );
});
