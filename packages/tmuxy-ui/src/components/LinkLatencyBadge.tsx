/**
 * The round trip to the server, shown only when it is long enough to feel
 * (infra/linkLatency.ts): a key that takes 200 ms to show is then the link's
 * doing, and the user can tell it from a program that stopped answering.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { useAppSelector } from '../machines/appHooks';
import { linkLatency, watchCommandTimings } from '../infra/linkLatency';
import { Tooltip } from './Tooltip';

export function LinkLatencyBadge() {
  const slow = useSyncExternalStore(linkLatency.subscribe, linkLatency.getSnapshot);
  const connected = useAppSelector((ctx) => ctx.connected);

  useEffect(() => watchCommandTimings(), []);
  // A dropped stream has its own notice, and comes back over a link that may
  // be another one.
  useEffect(() => {
    if (!connected) linkLatency.reset();
  }, [connected]);

  if (!slow) return null;
  return (
    <Tooltip label={`Slow link: every key takes at least ${slow.ms} ms to show`}>
      <span
        className={`link-latency is-${slow.level}`}
        role="status"
        aria-label={`Slow link: the server answers in about ${slow.ms} milliseconds`}
        data-testid="link-latency"
      >
        {slow.ms} ms
      </span>
    </Tooltip>
  );
}
