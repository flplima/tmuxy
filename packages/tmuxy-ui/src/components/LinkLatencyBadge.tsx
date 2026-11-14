/**
 * The round trip to the server, shown only when it is long enough to feel
 * (infra/linkLatency.ts): a key that takes 200 ms to show is then the link's
 * doing, and the user can tell it from a program that stopped answering.
 *
 * The desktop's status bar explains it on hover. A phone has no hover, so
 * there (`explainOnTap`) it is a button whose tap says the same in the
 * snackbar.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { useAppSelector, useAppSend } from '../machines/appHooks';
import { linkLatency, watchCommandTimings } from '../infra/linkLatency';
import { Tooltip } from './Tooltip';
import './LinkLatencyBadge.css';

export function LinkLatencyBadge({ explainOnTap = false }: { explainOnTap?: boolean }) {
  const send = useAppSend();
  const slow = useSyncExternalStore(linkLatency.subscribe, linkLatency.getSnapshot);
  const connected = useAppSelector((ctx) => ctx.connected);

  useEffect(() => watchCommandTimings(), []);
  // A dropped stream has its own notice, and comes back over a link that may
  // be another one.
  useEffect(() => {
    if (!connected) linkLatency.reset();
  }, [connected]);

  if (!slow) return null;
  const explanation = `Slow link: every key takes at least ${slow.ms} ms to show`;
  const badge = {
    className: `link-latency is-${slow.level}`,
    'aria-label': `Slow link: the server answers in about ${slow.ms} milliseconds`,
    'data-testid': 'link-latency',
  };
  if (explainOnTap) {
    return (
      <button
        type="button"
        {...badge}
        onClick={() => send({ type: 'NOTIFY', text: explanation, kind: 'info' })}
      >
        {slow.ms} ms
      </button>
    );
  }
  return (
    <Tooltip label={explanation}>
      <span role="status" {...badge}>
        {slow.ms} ms
      </span>
    </Tooltip>
  );
}
