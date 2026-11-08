import { Cause } from 'effect';
import { formatAdapterError, type AdapterError } from '../../infra/transport/AdapterError';
import type { OpError } from '../../domain/store/types';
import { tracer } from '../../infra/tracer';

/**
 * What a failed request tells the user, traced by its typed tag (never its
 * text). A defect (a throw inside a driver or a decoder) is logged with its
 * trace and reported as one; an interruption reports nothing (null).
 */
export function failureText(cause: Cause.Cause<AdapterError | OpError>): string | null {
  const failure = Cause.failureOption(cause);
  if (failure._tag === 'Some') {
    const e = failure.value;
    tracer.event({ layer: 'effect', name: 'fail', code: e._tag });
    switch (e._tag) {
      case 'OpRejectedByTmux':
        return e.stderr;
      case 'OpTransportError':
        return e.reason;
      default:
        return formatAdapterError(e);
    }
  }
  if (Cause.isInterruptedOnly(cause)) return null;
  tracer.event({ layer: 'effect', name: 'fail', code: 'defect' });
  console.error('[tmuxy] defect:', Cause.pretty(cause));
  return 'internal error (see the console)';
}
