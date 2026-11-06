/**
 * The app machine. Its actors are stubs here; AppContext.tsx provides the
 * real ones, built over the app runtime.
 */

import { RECONNECT_NOTICE_DELAY_MS } from '../constants';
import {
  setup,
  sendTo,
  raise,
  type ActorRefFrom,
  fromCallback,
  type AnyActorRef,
  type EventObject,
} from 'xstate';
import type { AppMachineContext } from '../types/context';
import type { AllAppMachineEvents } from '../types/events';
import { createInitialContext } from './context';
import { uiPrefsState } from './states/uiPrefs';
import { uiPrefsActions } from './actions/uiPrefs';
import { pluginsState } from './states/plugins';
import { pluginsActions } from './actions/plugins';
import { commandUiState } from './states/commandUi';
import { commandUiActions } from './actions/commandUi';
import { notificationsState } from './states/notifications';
import { notificationsActions } from './actions/notifications';
import { copyModeState } from './states/copyMode';
import { copyModeActions } from './actions/copyMode';
import { groupsAndFloatsGlobalEvents, groupsAndFloatsIdleEvents } from './states/groupsAndFloats';
import { groupsAndFloatsActions } from './actions/groupsAndFloats';
import { sidebarsGlobalEvents, sidebarsIdleEvents } from './states/sidebars';
import { sidebarsActions } from './actions/sidebars';
import { layoutGlobalEvents, layoutState } from './states/layout';
import { askState } from './states/ask';
import { tabOverviewGlobalEvents } from './states/tabOverview';
import { phoneGlobalEvents } from './states/phone';
import { gesturesGlobalEvents } from './states/gestures';
import { gesturesActions } from './actions/gestures';
import { tabOverviewActions } from './actions/tabOverview';
import { phoneActions } from './actions/phone';
import { layoutActions } from './actions/layout';
import { dispatchActions } from './dispatch';
import { askActions } from './actions/ask';
import { connectionGlobalEvents } from './states/connection';
import { connectionActions } from './actions/connection';
import { viewportGlobalEvents } from './states/viewport';
import { viewportActions } from './actions/viewport';
import { layoutModelUpdateActions } from './actions/layout/modelUpdate';
import { applyFontSize } from '../../infra/fontSizeManager';

import { dragMachine } from '../drag/dragMachine';
import { resizeMachine } from '../resize/resizeMachine';
import type { TmuxStoreActorEvent } from '../actors/tmuxStoreActor';
import type { KeyboardActorInput } from '../actors/keyboardActor';
import type { TmuxActorEvent } from '../actors/tmuxActor';
import type { SizeActorEvent } from '../actors/sizeActor';
import type { LinkModifierActorEvent } from '../actors/linkModifierActor';
import type { GestureActorEvent } from '../gestures/gestureActor';
import type { ServersActorEvent, ServersActorInput } from '../actors/serversActor';
import { keyboardGlobalEvents } from './states/keyboard';
import { keyboardActions } from './actions/keyboard';
import { contextView } from '../contextView';
import { sameKeyboardSurface, selectKeyContext } from '../selectors/keyboard';
import { selectTreeVisible } from '../selectors/panesAndSidebars';

/** A server state goes to the store, which reconciles its ops against it. */
const relayState = { actions: 'relayState' } as const;

/** The one command path, open while the machine has a stream or is getting it back. */
const commandEntry = {
  SEND_TMUX_COMMAND: { actions: 'dispatch_command' },
  DISPATCH_OP: { actions: 'dispatch_op' },
} as const;

export const appMachine = setup({
  types: {
    context: {} as AppMachineContext,
    events: {} as AllAppMachineEvents,
  },
  actors: {
    tmuxActor: fromCallback<TmuxActorEvent, { parent: AnyActorRef }>(() => () => {}),
    tmuxStoreActor: fromCallback<TmuxStoreActorEvent, { parent: AnyActorRef }>(() => () => {}),
    keyboardActor: fromCallback<EventObject, KeyboardActorInput>(() => () => {}),
    sizeActor: fromCallback<SizeActorEvent, { parent: AnyActorRef }>(() => () => {}),
    linkModifierActor: fromCallback<LinkModifierActorEvent>(() => () => {}),
    gestureActor: fromCallback<GestureActorEvent, { parent: AnyActorRef }>(() => () => {}),
    serversActor: fromCallback<ServersActorEvent, ServersActorInput>(() => () => {}),
    dragMachine,
    resizeMachine,
  },
  actions: {
    ...uiPrefsActions,
    ...pluginsActions,
    ...commandUiActions,
    ...notificationsActions,
    ...copyModeActions,
    ...groupsAndFloatsActions,
    ...keyboardActions,
    ...sidebarsActions,
    ...tabOverviewActions,
    ...phoneActions,
    ...gesturesActions,
    ...layoutActions,
    ...dispatchActions,
    ...askActions,
    ...connectionActions,
    ...viewportActions,
    ...layoutModelUpdateActions,
    relayState: sendTo('tmuxStore', ({ event }) => ({
      type: 'RECONCILE_SERVER' as const,
      state: (event as Extract<AllAppMachineEvents, { type: 'TMUX_STATE_UPDATE' }>).state,
    })),
  },
}).createMachine({
  id: 'app',
  initial: 'connecting',
  context: createInitialContext(),
  entry: [({ context }) => applyFontSize(context.baseFontSize)],
  invoke: [
    {
      id: 'tmux',
      src: 'tmuxActor',
      input: ({ self }) => ({ parent: self }),
    },
    {
      id: 'tmuxStore',
      src: 'tmuxStoreActor',
      input: ({ self }) => ({ parent: self }),
    },
    {
      id: 'keyboard',
      src: 'keyboardActor',
      input: ({ self }) => ({
        parent: self,
        keys: contextView(self, selectKeyContext, sameKeyboardSurface),
      }),
    },
    {
      id: 'size',
      src: 'sizeActor',
      input: ({ self }) => ({ parent: self }),
    },
    {
      id: 'linkModifier',
      src: 'linkModifierActor',
    },
    {
      id: 'gestures',
      src: 'gestureActor',
      input: ({ self }) => ({ parent: self }),
    },
    {
      id: 'servers',
      src: 'serversActor',
      input: ({ self }) => ({ parent: self, treeVisible: contextView(self, selectTreeVisible) }),
    },
    {
      id: 'dragLogic',
      src: 'dragMachine',
    },
    {
      id: 'resizeLogic',
      src: 'resizeMachine',
    },
  ],
  on: {
    ...uiPrefsState.on,
    ...pluginsState.on,
    ...commandUiState.on,
    ...notificationsState.on,
    ...groupsAndFloatsGlobalEvents,
    ...keyboardGlobalEvents,
    ...layoutGlobalEvents,
    ...sidebarsGlobalEvents,
    ...tabOverviewGlobalEvents,
    ...phoneGlobalEvents,
    ...gesturesGlobalEvents,
    ...connectionGlobalEvents,
    ...viewportGlobalEvents,

    TMUX_FATAL: { target: '.disconnected', actions: 'connection_fatal' },
    TMUX_DISCONNECTED: { target: '.disconnected', actions: 'connection_lost' },
    TMUX_RECONNECTING: { target: '.reconnecting', actions: 'connection_reconnecting' },
    TMUX_DETACHED: { target: '.detached', actions: 'connection_lost' },
  },
  states: {
    connecting: {
      on: {
        TMUX_CONNECTED: {
          target: 'idle',
          actions: 'connection_onConnected',
        },
        TMUX_ERROR: { actions: 'connection_error' },
      },
    },

    idle: {
      on: {
        ...copyModeState.on,
        ...groupsAndFloatsIdleEvents,
        ...sidebarsIdleEvents,
        ...layoutState.on,
        ...askState.on,

        ...commandEntry,
        TMUX_STATE_UPDATE: relayState,
        TMUX_MODEL_UPDATE: {
          actions: 'layout_modelUpdate',
        },
        TMUX_ERROR: {
          actions: raise(({ event }) => ({ type: 'NOTIFY' as const, text: event.error })),
        },
      },
    },

    // The channel dropped after a frame was shown. `quiet` for the first
    // RECONNECT_NOTICE_DELAY_MS, so a drop that heals at once is never seen;
    // then `noticed`, which the snackbar's ReconnectNotice renders. The panes
    // stay mounted and usable throughout: no overlay, no blur.
    reconnecting: {
      initial: 'quiet',
      states: {
        quiet: { after: { [RECONNECT_NOTICE_DELAY_MS]: 'noticed' } },
        noticed: {},
      },
      on: {
        // The adapter reports every failed attempt as a drop of its own. While
        // already reconnecting it is the same outage: the delay keeps counting
        // from the first drop and a shown notice stays shown.
        TMUX_RECONNECTING: {},
        TMUX_RECONNECTED: {
          target: 'idle',
          actions: 'connection_onReconnected',
        },
        // What is typed meanwhile goes on to the transport, which holds it
        // until the stream is back and sends it then (Q5).
        ...commandEntry,
        TMUX_STATE_UPDATE: relayState,
        TMUX_MODEL_UPDATE: {
          actions: 'layout_reconnectingModelUpdate',
        },
      },
    },

    detached: {
      on: {
        TMUX_CONNECTED: { target: 'idle', actions: 'connection_onConnected' },
        TMUX_RECONNECTED: { target: 'idle', actions: 'connection_onReconnected' },
        TMUX_STATE_UPDATE: relayState,
        TMUX_RECONNECTING: { target: 'reconnecting' },
      },
    },

    disconnected: {
      on: {
        TMUX_RECONNECTING: { target: 'reconnecting' },
        TMUX_CONNECTED: { target: 'idle', actions: 'connection_onConnected' },
      },
    },
  },
});

export type AppMachineActor = ActorRefFrom<typeof appMachine>;
