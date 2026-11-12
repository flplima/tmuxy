/**
 * A pane's row in the sidebar tree, line by line, as the row template says
 * (`domain/rowTemplate.ts`, the `@tmuxy-tree-row` option). The default
 * template draws what the row always drew: what the pane IS (its icon or
 * what it is doing, the process, its ports and id), WHERE it is (the cwd,
 * cut from the left so its end survives, and the branch), what it is
 * SHOWING (the program's own title, with the width to itself), and what a
 * script SAYS of it (its fields).
 */

import { Fragment, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';
import { PaneIcon } from './PaneIcon';
import { PaneStateMark } from './PaneStateMark';
import { portUrl } from './panePorts';
import type { GitBadge } from './sidebarTreeRows';
import type { TmuxPane } from '../domain/client';
import type { PaneField } from '../domain/paneMeta';
import type { RowItem, RowTemplate } from '../domain/rowTemplate';
import type { paneStateFor } from '../domain/paneState';
import { openExternalUrl } from '../infra/openUrl';
import { isTauri } from '../infra/platform';

/** Everything a pane's row can show. */
export interface PaneRowParts {
  pane: TmuxPane;
  state: ReturnType<typeof paneStateFor>;
  process: string;
  title: string;
  cwd: string;
  branch: GitBadge | null;
  ports: readonly number[] | undefined;
  fields: PaneField[] | undefined;
}

/** [`PaneRowParts`], and the fields the `fields` item draws. */
type LineParts = PaneRowParts & { rest: PaneField[] | undefined };

// The branch's slot is held even outside a repository, so every row's path
// gets the same width and the columns line up down the tree.
/** `+12 −3` as words: the signs alone read badly aloud. */
const changesLabel = (changes: NonNullable<GitBadge['changes']>) =>
  [
    changes.added && `${changes.added.slice(1)} lines added`,
    changes.removed && `${changes.removed.slice(1)} lines removed`,
  ]
    .filter(Boolean)
    .join(', ');

/**
 * The fields a script or an agent set on the pane (`tmuxy pane meta`), on a
 * line of their own: `ci passing  task parser rewrite`. The whole line is
 * the tooltip, since a narrow column cuts it.
 */
function FieldLine({ fields }: { fields: PaneField[] | undefined }) {
  if (!fields?.length) return null;
  const whole = fields.map((f) => `${f.key}: ${f.value}`).join('\n');
  return (
    <Tooltip label={whole}>
      <span className="sidebar-tree-fields" data-testid="tree-fields">
        {fields.map((field) => (
          <span key={field.key} className="sidebar-tree-field" data-field={field.key}>
            <span className="sidebar-tree-field-key">{field.key}</span> {field.value}
          </span>
        ))}
      </span>
    </Tooltip>
  );
}

/** Where a port's page is: this page's host in a browser, this machine on the desktop. */
const openPort = (port: number) =>
  openExternalUrl(portUrl(port, isTauri() ? null : window.location.hostname));

/**
 * The ports the pane's programs listen on, each a link to its page. Out of
 * the tree's arrow-key order (`tabIndex -1`), as the row is one stop; a
 * click is the row's own unless it lands on a port.
 */
function PortLinks({ ports }: { ports: readonly number[] | undefined }) {
  if (!ports?.length) return null;
  return (
    <span className="sidebar-tree-ports" data-testid="tree-ports">
      {ports.map((port) => (
        <Tooltip
          key={port}
          label={`Open ${portUrl(port, isTauri() ? null : window.location.hostname)}`}
        >
          <button
            type="button"
            tabIndex={-1}
            className="sidebar-tree-port"
            aria-label={`Open port ${port}`}
            data-port={port}
            onClick={(e) => {
              e.stopPropagation();
              openPort(port);
            }}
          >
            :{port}
          </button>
        </Tooltip>
      ))}
    </span>
  );
}

const badgeSpan = (badge: GitBadge | null) =>
  badge ? (
    <Tooltip label={badge.title}>
      <span className="sidebar-tree-git">
        <span className="sidebar-tree-git-name">{badge.text}</span>
        {badge.changes && (
          <span
            className="sidebar-tree-git-changes"
            role="img"
            aria-label={changesLabel(badge.changes)}
            data-testid="tree-git-changes"
          >
            {badge.changes.added && <span className="is-added">{badge.changes.added}</span>}
            {badge.changes.removed && <span className="is-removed">{badge.changes.removed}</span>}
          </span>
        )}
      </span>
    </Tooltip>
  ) : (
    <span className="sidebar-tree-git is-empty" aria-hidden="true" />
  );

/** Whether `item` has anything to show for this pane. */
function shows(item: RowItem, parts: LineParts): boolean {
  switch (item.kind) {
    case 'process':
    case 'id':
      return true;
    case 'ports':
      return Boolean(parts.ports?.length);
    case 'cwd':
      return Boolean(parts.cwd);
    case 'branch':
      return parts.branch !== null;
    case 'title':
      return Boolean(parts.title);
    case 'fields':
      return Boolean(parts.rest?.length);
    case 'field':
      return Boolean(parts.fields?.some((f) => f.key === item.key));
  }
}

function ProcessItem({ parts }: { parts: PaneRowParts }) {
  return (
    <>
      {parts.pane.marked && (
        <Tooltip label="Marked pane">
          <span className="sidebar-tree-mark" aria-label="Marked pane">
            ⚑
          </span>
        </Tooltip>
      )}
      {parts.state !== 'idle' ? (
        <PaneStateMark state={parts.state} className="sidebar-tree-icon sidebar-tree-state" />
      ) : (
        <PaneIcon pane={parts.pane} className="sidebar-tree-icon" />
      )}
      <span className="sidebar-tree-name">{parts.process}</span>
    </>
  );
}

const fieldSpan = (field: PaneField) => (
  <span key={field.key} className="sidebar-tree-field" data-field={field.key}>
    <span className="sidebar-tree-field-key">{field.key}</span> {field.value}
  </span>
);

/** One item as it sits in a line among others. */
function itemNode(item: RowItem, parts: LineParts): ReactNode {
  switch (item.kind) {
    case 'process':
      return <ProcessItem parts={parts} />;
    case 'ports':
      return <PortLinks ports={parts.ports} />;
    case 'id':
      return <span className="sidebar-tree-id">{parts.pane.tmuxId}</span>;
    case 'cwd':
      return <span className="sidebar-tree-cwd">{parts.cwd && `\u200e${parts.cwd}\u200e`}</span>;
    case 'branch':
      return badgeSpan(parts.branch);
    case 'title':
      return parts.title && <span className="sidebar-tree-title-inline">{parts.title}</span>;
    case 'fields':
      return parts.rest?.map(fieldSpan);
    case 'field': {
      const field = parts.fields?.find((f) => f.key === item.key);
      return field && fieldSpan(field);
    }
  }
}

const isWhere = (item: RowItem) => item.kind === 'cwd' || item.kind === 'branch';

/**
 * One line: left out when none of its items has anything to show. A line
 * of the title alone, of the fields alone, or of the cwd and branch is drawn
 * the way the tree always drew it, with its own width and cut.
 */
function Line({ items, parts }: { items: readonly RowItem[]; parts: LineParts }) {
  if (!items.some((it) => shows(it, parts))) return null;
  const only = items.length === 1 ? items[0].kind : null;
  if (only === 'title') return <span className="sidebar-tree-title">{parts.title}</span>;
  if (only === 'fields') return <FieldLine fields={parts.rest} />;
  const nodes = items.map((it, i) => <Fragment key={i}>{itemNode(it, parts)}</Fragment>);
  return (
    <span className={items.every(isWhere) ? 'sidebar-tree-where' : 'sidebar-tree-line'}>
      {nodes}
    </span>
  );
}

export function PaneRowLines({ template, parts }: { template: RowTemplate; parts: PaneRowParts }) {
  // A field the template names on its own (`field:ci`) is not drawn again
  // among `fields`: those are the rest.
  const named = new Set(
    template.flat().flatMap((item) => (item.kind === 'field' ? [item.key] : [])),
  );
  const rest = parts.fields?.filter((field) => !named.has(field.key));
  const shown = { ...parts, rest };
  return (
    <>
      {template.map((items, i) => (
        <Line key={i} items={items} parts={shown} />
      ))}
    </>
  );
}
