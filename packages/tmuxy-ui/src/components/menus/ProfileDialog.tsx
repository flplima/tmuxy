/**
 * The dialog behind View > Profiles' New, Duplicate, Rename and Delete: a
 * name to type, checked as it is typed, or a delete to confirm. The backend
 * checks the name again and answers with what it refused.
 */

import { useState } from 'react';
import { Modal } from '../Modal';
import { profileRequest, type ProfileCall } from '../../domain/backendCalls';
import type { ProfilesInfo } from '../../domain/wireSettings';
import type { ProfileDialogKind } from './specs/actions';

const TEXT: Record<ProfileDialogKind, { title: string; action: string }> = {
  new: { title: 'New Profile', action: 'Create' },
  duplicate: { title: 'Duplicate Profile', action: 'Duplicate' },
  rename: { title: 'Rename Profile', action: 'Rename' },
  delete: { title: 'Delete Profile', action: 'Delete' },
};

/** `base`, or `base 2`, `base 3`… : the first one no profile has. */
function freeName(base: string, names: readonly string[]): string {
  if (!names.includes(base)) return base;
  let n = 2;
  while (names.includes(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

function firstName(kind: ProfileDialogKind, { active, names }: ProfilesInfo): string {
  if (kind === 'new') return freeName('Profile', names);
  if (kind === 'duplicate') return freeName(`${active} copy`, names);
  return active;
}

function problemWith(kind: ProfileDialogKind, name: string, profiles: ProfilesInfo): string | null {
  if (kind === 'delete') return null;
  if (name.trim() === '') return 'A profile needs a name.';
  if (name !== name.trim()) return 'A name cannot start or end with a space.';
  if (kind === 'rename' && name === profiles.active) return null;
  return profiles.names.includes(name) ? `A profile named ${name} already exists.` : null;
}

function callFor(kind: ProfileDialogKind, name: string, active: string): ProfileCall {
  switch (kind) {
    case 'new':
      return profileRequest('create_profile', { name, from: null });
    case 'duplicate':
      return profileRequest('create_profile', { name, from: active });
    case 'rename':
      return profileRequest('rename_profile', { from: active, to: name });
    case 'delete':
      return profileRequest('delete_profile', { name: active });
  }
}

interface ProfileDialogProps {
  kind: ProfileDialogKind;
  profiles: ProfilesInfo;
  onClose: () => void;
  onSubmit: (call: ProfileCall) => void;
}

export function ProfileDialog({ kind, profiles, onClose, onSubmit }: ProfileDialogProps) {
  const [name, setName] = useState(() => firstName(kind, profiles));
  const problem = problemWith(kind, name, profiles);
  const unchanged = kind === 'rename' && name === profiles.active;
  const submit = () => {
    if (problem || unchanged) return;
    onSubmit(callFor(kind, name, profiles.active));
  };
  const { title, action } = TEXT[kind];
  return (
    <Modal open title={title} width={360} onClose={onClose} className="profile-dialog">
      {kind === 'delete' ? (
        <p className="app-menu-dialog-text">
          Delete the profile <strong>{profiles.active}</strong>? This session goes back to the
          Default Profile.
        </p>
      ) : (
        <form
          className="app-menu-dialog-text"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="app-menu-dialog-field">
            Name
            <input
              autoFocus
              value={name}
              aria-invalid={problem !== null}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {problem && <p className="app-menu-dialog-problem">{problem}</p>}
        </form>
      )}
      <div className="app-menu-dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={kind === 'delete' ? 'is-destructive' : undefined}
          disabled={problem !== null || unchanged}
          onClick={submit}
        >
          {action}
        </button>
      </div>
    </Modal>
  );
}
