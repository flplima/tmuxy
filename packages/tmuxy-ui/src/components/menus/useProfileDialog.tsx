/**
 * View > Profiles' dialog, opened from a menu item and closed by its buttons:
 * what it asks for is sent as a profile command.
 */

import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAppSend, useAppSelector } from '../../machines/appHooks';
import { ProfileDialog } from './ProfileDialog';
import type { ProfileDialogKind } from './specs/actions';

export function useProfileDialog(): {
  open: (kind: ProfileDialogKind) => void;
  dialog: ReactNode;
} {
  const send = useAppSend();
  const profiles = useAppSelector((c) => c.profiles);
  const [kind, setKind] = useState<ProfileDialogKind | null>(null);
  const close = () => setKind(null);
  const dialog =
    kind && profiles
      ? createPortal(
          <ProfileDialog
            kind={kind}
            profiles={profiles}
            onClose={close}
            onSubmit={(call) => {
              close();
              send({ type: 'PROFILE_CALL', call });
            }}
          />,
          document.body,
        )
      : null;
  return { open: setKind, dialog };
}
