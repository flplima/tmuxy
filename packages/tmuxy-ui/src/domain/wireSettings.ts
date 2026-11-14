/**
 * The backend's answers about client settings, as Effect Schemas beside the
 * protocol's (`wire.ts`): the themes it ships (`get_themes_list`) and the
 * local action trace's switch (`get_trace_settings`, docs/TRACING.md).
 */

import { Schema } from 'effect';

/** What the Theme menu offers: a palette, or the operating system's choice. */
export type ThemeMode = 'dark' | 'light' | 'auto';
export type ResolvedThemeMode = Exclude<ThemeMode, 'auto'>;

/** A theme mode as stored or sent: anything that is not one reads as `dark`. */
export function parseThemeMode(mode: unknown): ThemeMode {
  return mode === 'light' || mode === 'auto' ? mode : 'dark';
}

export const ThemeInfo = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  /** The modes the file declares a palette for. */
  modes: Schema.Array(Schema.String),
});
export type ThemeInfo = Schema.Schema.Type<typeof ThemeInfo>;

/**
 * The terminal profiles and the one this session uses (`profiles.rs`): what
 * every profile command answers. `names` lists the Default Profile first.
 */
export const ProfilesInfo = Schema.Struct({
  active: Schema.String,
  names: Schema.Array(Schema.String),
});
export type ProfilesInfo = Schema.Schema.Type<typeof ProfilesInfo>;

/** Usefulness↔sensitivity dial for the local action trace. */
export const TraceLevel = Schema.Literal('shape', 'labeled', 'full');
export type TraceLevel = Schema.Schema.Type<typeof TraceLevel>;

export const TraceSettings = Schema.Struct({
  enabled: Schema.Boolean,
  level: TraceLevel,
  /** File the backend writes to; null when no state dir could be resolved. */
  path: Schema.NullOr(Schema.String),
  /** A DO_NOT_TRACK / TMUXY_NO_TRACE kill switch forbids turning it on. */
  locked: Schema.Boolean,
});
export type TraceSettings = Schema.Schema.Type<typeof TraceSettings>;

/** The last actions of the trace, redacted for sharing (`get_trace_share`). */
export const TraceShare = Schema.Struct({
  /** NDJSON, one redacted event a line: exactly what Copy Trace copies. */
  text: Schema.String,
  lines: Schema.Number,
});
export type TraceShare = Schema.Schema.Type<typeof TraceShare>;
