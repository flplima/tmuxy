import { useAppConfig, useReadOnly } from '../../machines/AppContext';
import { isMacPlatform, isTauri } from '../../utils/platform';
import type { MenuEnv } from '../../domain/menus/spec';

/** Where this menu is shown, for the spec builders. */
export function useMenuEnv(): MenuEnv {
  const readOnly = useReadOnly();
  const { isDemo } = useAppConfig();
  return { readOnly, isDemo: Boolean(isDemo), isTauri: isTauri(), isMac: isMacPlatform() };
}
