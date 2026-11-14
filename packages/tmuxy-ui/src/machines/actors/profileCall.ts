/**
 * A View menu profile command, sent and answered: every one answers the
 * profiles there are and the one this session uses.
 */

import type { Effect } from 'effect';
import type { ProfileCall } from '../../domain/backendCalls';
import type { ProfilesInfo } from '../../domain/wireSettings';
import type { AdapterError } from '../../infra/transport/AdapterError';
import type { TmuxTransportService } from '../../infra/transport/TmuxTransport';

export function profileCall(
  t: TmuxTransportService,
  call: ProfileCall,
): Effect.Effect<ProfilesInfo, AdapterError> {
  switch (call.cmd) {
    case 'list_profiles':
      return t.call(call.cmd, call.args);
    case 'use_profile':
      return t.call(call.cmd, call.args);
    case 'create_profile':
      return t.call(call.cmd, call.args);
    case 'rename_profile':
      return t.call(call.cmd, call.args);
    case 'delete_profile':
      return t.call(call.cmd, call.args);
  }
}
