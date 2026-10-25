import { useAppConfig } from '../../machines/appHooks';
import { isMacPlatform, isTauri } from '../../utils/platform';
import type { MenuEnv } from '../../domain/menus/spec';

/** Where this menu is shown, for the spec builders. */
export function useMenuEnv(): MenuEnv {
  const { isDemo } = useAppConfig();
  return { isDemo: Boolean(isDemo), isTauri: isTauri(), isMac: isMacPlatform() };
}
