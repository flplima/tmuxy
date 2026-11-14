import { describe, expect, it } from 'vitest';
import { profilesMenuSpec } from '../profilesMenu';
import type { AppMenuNode } from '../actions';

const DEFAULT = 'Default Profile';

type Item = Extract<AppMenuNode, { kind: 'item' | 'checkbox' }>;

const byLabel = (spec: readonly AppMenuNode[], label: string): Item => {
  const node = spec.find(
    (n): n is Item => (n.kind === 'item' || n.kind === 'checkbox') && n.label === label,
  );
  if (!node) throw new Error(`no item ${label}`);
  return node;
};

describe('profilesMenuSpec', () => {
  it('is empty until the backend has answered', () => {
    expect(profilesMenuSpec(null)).toEqual([]);
  });

  it("checks the session's profile, and switching sends use_profile", () => {
    const spec = profilesMenuSpec({ active: 'Night', names: [DEFAULT, 'Night'] });
    expect(byLabel(spec, DEFAULT)).toMatchObject({ kind: 'checkbox', checked: false });
    expect(byLabel(spec, 'Night')).toMatchObject({ kind: 'checkbox', checked: true });
    expect(byLabel(spec, DEFAULT).action).toEqual({
      kind: 'event',
      event: { type: 'PROFILE_CALL', call: { cmd: 'use_profile', args: { name: DEFAULT } } },
    });
  });

  it('the Default Profile can be copied but not renamed or deleted', () => {
    const onDefault = profilesMenuSpec({ active: DEFAULT, names: [DEFAULT, 'Night'] });
    expect(byLabel(onDefault, 'New Profile…').disabled).toBe(false);
    expect(byLabel(onDefault, 'Duplicate Profile…').disabled).toBe(false);
    expect(byLabel(onDefault, 'Rename Profile…').disabled).toBe(true);
    expect(byLabel(onDefault, 'Delete Profile…').disabled).toBe(true);
    const onNight = profilesMenuSpec({ active: 'Night', names: [DEFAULT, 'Night'] });
    expect(byLabel(onNight, 'Rename Profile…').disabled).toBe(false);
    expect(byLabel(onNight, 'Delete Profile…').action).toEqual({
      kind: 'local',
      local: { verb: 'profile-dialog', dialog: 'delete' },
    });
  });
});
