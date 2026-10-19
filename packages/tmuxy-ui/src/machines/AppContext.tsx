/**
 * AppProvider - builds the runtime, store and actors once and provides the
 * XState app machine to the tree. The hooks that read it are in `appHooks.ts`;
 * the contexts and config type are in `appContexts.ts`.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useActorRef } from '@xstate/react';
import { appMachine } from './app/appMachine';
import type { Layer } from 'effect';
import type { TmuxTransport } from '../infra/transport/TmuxTransport';
import { transportForEnvironment } from '../infra/transport/layers';
import { makeAppRuntime } from '../infra/runtime';
import { tracer } from '../infra/tracer';
import { createTmuxActor } from './actors/tmuxActor';
import { createKeyboardActor } from './actors/keyboardActor';
import { createLinkModifierActor } from './actors/linkModifierActor';
import { createGestureActor } from './actors/gestureActor';
import { createSizeActor } from './actors/sizeActor';
import { createServersActor } from './actors/serversActor';
import { createTmuxStoreActor } from './actors/tmuxStoreActor';
import { makeTmuxStore } from '../infra/store/TmuxStore';
import { measureCellMetrics } from '../utils/cellMetrics';
import { isTauri } from '../utils/platform';
import {
  AppActorContext,
  AppConfigContext,
  AppRuntimeContext,
  type AppConfig,
} from './appContexts';

export function AppProvider({
  children,
  transport,
  config,
}: {
  children: ReactNode;
  /** The backend to run against; the environment's (web, desktop, `?demo`) when omitted. */
  transport?: Layer.Layer<TmuxTransport>;
  config?: AppConfig;
}) {
  // Create the runtime, store, and actors once, from the props of the first
  // render: a provider never swaps its backend underneath a running machine.
  // The runtime is built from the transport Layer and every actor runs its
  // effects on it. The TmuxStore is the client model — owns optimistic patches
  // and reconciliation; the tmuxStoreActor bridges it into XState so the
  // appMachine context stays a passive mirror of the store's derived snapshot.
  const [{ runtime, actors }] = useState(() => {
    const runtime = makeAppRuntime(transport ?? transportForEnvironment());
    const store = makeTmuxStore();
    return {
      runtime,
      actors: {
        tmuxActor: createTmuxActor(runtime),
        tmuxStoreActor: createTmuxStoreActor(store, runtime),
        keyboardActor: createKeyboardActor(),
        linkModifierActor: createLinkModifierActor(),
        // Trackpad gestures are the desktop app's (docs/DESKTOP.md): the web
        // build keeps the machine's no-op actor and the browser its own
        // wheel, pinch-zoom and history swipe.
        ...((config?.desktopGestures ?? isTauri()) ? { gestureActor: createGestureActor() } : {}),
        sizeActor: createSizeActor(measureCellMetrics, { phoneLayout: config?.phoneLayout }),
        serversActor: createServersActor(runtime),
      },
    };
  });

  const actorRef = useActorRef(
    appMachine.provide({
      actors,
    }),
  );

  // Expose the XState actor for E2E tests, and tap `send` so the action
  // tracer sees every dispatched event.
  useMemo(() => {
    if (typeof window === 'undefined') return;
    const originalSend = actorRef.send.bind(actorRef);
    (actorRef as { send: (event: unknown) => void }).send = (event: unknown) => {
      // Action tracing: record only the event *type* (a variant name like
      // DISPATCH_OP), never its payload — the payload can carry keystrokes.
      // The derived model-update firehose is coalesced to a periodic count so it
      // doesn't drown the trace.
      const type = (event as { type?: string })?.type;
      if (type === 'TMUX_MODEL_UPDATE') tracer.count('xstate', type);
      else if (type) tracer.event({ layer: 'xstate', name: type });
      return originalSend(event as Parameters<typeof originalSend>[0]);
    };
    (window as unknown as { app: typeof actorRef }).app = actorRef;
  }, [actorRef]);

  return (
    <AppConfigContext.Provider value={config ?? {}}>
      <AppRuntimeContext.Provider value={runtime}>
        <AppActorContext.Provider value={actorRef}>{children}</AppActorContext.Provider>
      </AppRuntimeContext.Provider>
    </AppConfigContext.Provider>
  );
}
