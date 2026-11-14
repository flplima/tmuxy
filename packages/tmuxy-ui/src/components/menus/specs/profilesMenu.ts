/**
 * View > Profiles: the terminal profiles, this session's checked, and the
 * items that make, copy, rename and delete one (docs/PROFILES.md). The
 * Default Profile, listed first, changes nothing and has no file: it cannot
 * be renamed or deleted.
 */

import { profileRequest } from '../../../domain/backendCalls';
import type { ProfilesInfo } from '../../../domain/wireSettings';
import { separator, tidy } from '../../../domain/menus/spec';
import {
  event,
  local,
  type AppMenuNode,
  type AppMenuSpec,
  type ProfileDialogKind,
} from './actions';

const DIALOG_ITEMS: ReadonlyArray<{ dialog: ProfileDialogKind; label: string; named: boolean }> = [
  { dialog: 'new', label: 'New Profile…', named: false },
  { dialog: 'duplicate', label: 'Duplicate Profile…', named: false },
  { dialog: 'rename', label: 'Rename Profile…', named: true },
  { dialog: 'delete', label: 'Delete Profile…', named: true },
];

/** View > Profiles itself: the list is read again each time it opens. */
export function profilesSubmenu(profiles: ProfilesInfo | null): AppMenuNode {
  return {
    kind: 'submenu',
    id: 'menu-profiles',
    label: 'Profiles',
    onOpen: event({ type: 'PROFILE_CALL', call: profileRequest('list_profiles', {}) }),
    children: profilesMenuSpec(profiles),
  };
}

export function profilesMenuSpec(profiles: ProfilesInfo | null): AppMenuSpec {
  if (!profiles) return [];
  const onDefault = profiles.active === profiles.names[0];
  return tidy([
    ...profiles.names.map(
      (name, index): AppMenuNode => ({
        kind: 'checkbox',
        id: `profile-use-${index}`,
        label: name,
        checked: profiles.active === name,
        action: event({ type: 'PROFILE_CALL', call: profileRequest('use_profile', { name }) }),
      }),
    ),
    separator,
    ...DIALOG_ITEMS.map(
      ({ dialog, label, named }): AppMenuNode => ({
        kind: 'item',
        id: `profile-${dialog}`,
        label,
        disabled: named && onDefault,
        action: local({ verb: 'profile-dialog', dialog }),
      }),
    ),
  ]);
}
