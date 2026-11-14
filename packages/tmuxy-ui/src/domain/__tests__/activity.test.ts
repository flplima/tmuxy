import { describe, it, expect } from 'vitest';
import {
  activityPlace,
  filterActivity,
  LIST_ACTIVITY_COMMAND,
  mostUrgent,
  parseActivity,
} from '../activity';
import { STASH_SESSION } from '../tmuxyConstants.gen';

/** One `list-panes -a` row, in the order the command asks for. */
const row = (
  session: string,
  window: string,
  index: number,
  pane: string,
  state: string,
  extra: { status?: string; command?: string; label?: string; title?: string; tab?: string } = {},
) =>
  [
    session,
    window,
    index,
    pane,
    state,
    extra.status ?? '',
    extra.command ?? 'zsh',
    extra.label ?? '',
    extra.title ?? '',
    extra.tab ?? 'main',
  ].join('\t');

const LISTING = [
  row('work', '@1', 0, '%1', 'working', { command: 'cargo' }),
  row('work', '@1', 0, '%2', ''),
  row('work', '@2', 1, '%3', 'unread', { label: 'build', tab: 'ci' }),
  row('play', '@5', 0, '%7', 'needs-input', {
    command: 'claude',
    title: 'Fix the parser',
    // "Apply 3 to add?"
    status: 'state=blocked:kind=permission:msg=QXBwbHkgMyB0byBhZGQ/',
  }),
  row('play', '@5', 0, '%8', 'error'),
  row('play', '@6', 1, '%9', 'idle'),
  row(STASH_SESSION, '@9', 0, '%12', 'needs-input'),
  row('work', '@1', 0, '%13', 'sleeping'),
  'not a row',
  '',
].join('\n');

describe('parseActivity', () => {
  const rows = parseActivity(LISTING);

  it('lists the panes that declared a state, the one that wants the user most first', () => {
    expect(rows.map((r) => [r.paneId, r.state])).toEqual([
      ['%7', 'needs-input'],
      ['%8', 'error'],
      ['%3', 'unread'],
      ['%1', 'working'],
      ['%9', 'idle'],
    ]);
  });

  it('leaves out a pane that said nothing, a parked group member and a state it does not know', () => {
    const ids = rows.map((r) => r.paneId);
    expect(ids).not.toContain('%2');
    expect(ids).not.toContain('%12');
    expect(ids).not.toContain('%13');
  });

  it('names a pane by its label, else its program’s title, else the program', () => {
    const name = (id: string) => rows.find((r) => r.paneId === id)?.name;
    expect(name('%3')).toBe('build');
    expect(name('%7')).toBe('Fix the parser');
    expect(name('%1')).toBe('cargo');
  });

  it('says the state in words, with what the program said behind it', () => {
    const said = (id: string) => rows.find((r) => r.paneId === id)?.said;
    expect(said('%7')).toBe('Needs your approval: Apply 3 to add?');
    expect(said('%8')).toBe('Failed');
    expect(said('%3')).toBe('New output');
  });

  it('keeps where each pane is', () => {
    const build = rows.find((r) => r.paneId === '%3');
    expect(build).toMatchObject({ session: 'work', windowId: '@2', tab: 'ci', tabIndex: 1 });
    expect(activityPlace(build!)).toBe('work · ci');
  });

  // The desktop's second window is a grouped session (`work~1`) with the
  // first one's panes: list-panes -a lists each of them twice.
  it('lists a pane once, from the first session that has it', () => {
    const twice = [row('work', '@1', 0, '%1', 'error'), row('work~1', '@1', 0, '%1', 'error')].join(
      '\n',
    );
    expect(parseActivity(twice).map((r) => [r.paneId, r.session])).toEqual([['%1', 'work']]);
  });

  it('keeps a tab name that has a tab in it whole', () => {
    const [only] = parseActivity(row('work', '@1', 0, '%1', 'working', { tab: 'a\tb' }));
    expect(only.tab).toBe('a\tb');
  });

  it('asks tmux for every pane of every session', () => {
    expect(LIST_ACTIVITY_COMMAND.startsWith("list-panes -a -F '")).toBe(true);
    expect(LIST_ACTIVITY_COMMAND).toContain('#{@tmuxy-pane-state}');
    expect(LIST_ACTIVITY_COMMAND).toContain('#{@tmuxy-pane-status}');
  });
});

describe('filterActivity', () => {
  const rows = parseActivity(LISTING);
  const ids = (query: string) => filterActivity(rows, query).map((r) => r.paneId);

  it('matches the session, the tab, the name and the words, ignoring case', () => {
    expect(ids('PLAY')).toEqual(['%7', '%8', '%9']);
    expect(ids('ci')).toEqual(['%3']);
    expect(ids('parser')).toEqual(['%7']);
    expect(ids('approval')).toEqual(['%7']);
    expect(ids('  ')).toHaveLength(5);
    expect(ids('nothing like it')).toEqual([]);
  });
});

describe('mostUrgent', () => {
  const rows = parseActivity(LISTING);

  it('is the first pane that waits, failed or has a result', () => {
    expect(mostUrgent(rows, null)?.paneId).toBe('%7');
  });

  it('is never the pane in front', () => {
    expect(mostUrgent(rows, rows[0].paneId)?.paneId).toBe('%8');
  });

  it('is nobody when every pane is only working or idle', () => {
    const quiet = rows.filter((r) => r.state === 'working' || r.state === 'idle');
    expect(mostUrgent(quiet, null)).toBeNull();
    expect(mostUrgent([], null)).toBeNull();
  });
});
