import { useEffect, type RefObject } from 'react';

/** Keep the option the arrows reached in view as `activeKey` changes. */
export function useActiveOptionInView(
  listRef: RefObject<HTMLDivElement | null>,
  activeKey: string | undefined,
): void {
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [listRef, activeKey]);
}
