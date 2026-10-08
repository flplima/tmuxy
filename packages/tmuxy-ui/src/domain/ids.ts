/**
 * Branded identities of the tmux world.
 *
 * tmux names a pane `%N` and a window `@N`; tmuxy names a pane group `gN`
 * (`@tmuxy-group-id`). All three are strings on the wire, and a plain
 * `string` would let a window id be passed where a pane id belongs. Each is
 * an Effect Schema with a brand, so the type and its runtime check are one
 * definition: the wire decoder (`domain/wire.ts`) validates every id once,
 * and from there on the compiler keeps them apart.
 *
 * Getting a branded id:
 *   - from the wire: decode it (the wire schemas use these);
 *   - from an untrusted string (a DOM `data-*` attribute, tmux output the
 *     client parses, a command argument): the guards (`isPaneId`,
 *     `isWindowId`, `isModelPaneId`, `isModelWindowId`);
 *   - from a literal the code itself wrote (tests, fixtures): `PaneId.make`,
 *     `WindowId.make`, `GroupId.make` — they validate and throw on a bad one;
 *   - a predicted entity the optimistic store invents before tmux confirms
 *     it: `placeholderPaneId` / `placeholderWindowId`, the only ids that do
 *     not match tmux's form.
 */

import { Schema } from 'effect';

/** The prefix of an id the client predicted and tmux has not confirmed. */
const PLACEHOLDER_PREFIX = '__placeholder_';

const PANE_PATTERN = /^%\d+$/;
const WINDOW_PATTERN = /^@\d+$/;

const isPlaceholder = (s: string): boolean => s.startsWith(PLACEHOLDER_PREFIX);

/** A tmux pane id, `%N`. The only form the wire carries. */
export const PaneId = Schema.String.pipe(Schema.pattern(PANE_PATTERN), Schema.brand('PaneId'));
export type PaneId = Schema.Schema.Type<typeof PaneId>;

/** A tmux window id, `@N`. The only form the wire carries. */
export const WindowId = Schema.String.pipe(
  Schema.pattern(WINDOW_PATTERN),
  Schema.brand('WindowId'),
);
export type WindowId = Schema.Schema.Type<typeof WindowId>;

/** A pane group's id (`@tmuxy-group-id`, e.g. `g5`). */
export const GroupId = Schema.NonEmptyString.pipe(Schema.brand('GroupId'));
export type GroupId = Schema.Schema.Type<typeof GroupId>;

/**
 * A pane id as the client model holds it: tmux's `%N`, or a placeholder for a
 * pane the optimistic store predicted. Same brand as `PaneId` — a placeholder
 * stands in for the pane tmux is about to create — but never accepted from
 * the wire.
 */
const ModelPaneId = Schema.String.pipe(
  Schema.filter((s) => PANE_PATTERN.test(s) || isPlaceholder(s)),
  Schema.brand('PaneId'),
);

/** A window id as the client model holds it; see `ModelPaneId`. */
const ModelWindowId = Schema.String.pipe(
  Schema.filter((s) => WINDOW_PATTERN.test(s) || isPlaceholder(s)),
  Schema.brand('WindowId'),
);

/** `u` is a tmux pane id (`%N`). */
export const isPaneId = Schema.is(PaneId);
/** `u` is a tmux window id (`@N`). */
export const isWindowId = Schema.is(WindowId);
/** `u` names a pane in the client model: a tmux id or a placeholder (e.g. a DOM `data-pane-id`). */
export const isModelPaneId = Schema.is(ModelPaneId);
/** `u` names a window in the client model: a tmux id or a placeholder. */
export const isModelWindowId = Schema.is(ModelWindowId);

/**
 * The id of a pane the optimistic store predicted (a split's new pane, a new
 * tab's pane). tmux has never heard of it: `isPlaceholderId` tells it apart,
 * and nothing may target it in a command.
 */
export function placeholderPaneId(key: string): PaneId {
  return ModelPaneId.make(`${PLACEHOLDER_PREFIX}${key}`);
}

/** The id of a window the optimistic store predicted; see `placeholderPaneId`. */
export function placeholderWindowId(key: string): WindowId {
  return ModelWindowId.make(`${PLACEHOLDER_PREFIX}${key}`);
}

/** The id is a client-side prediction, not something tmux knows. */
export function isPlaceholderId(id: PaneId | WindowId): boolean {
  return isPlaceholder(id);
}

/** tmux's number for a pane (`%12` → 12); 0 for a placeholder. */
export function paneNumber(id: PaneId): number {
  return isPlaceholder(id) ? 0 : Number(id.slice(1));
}
