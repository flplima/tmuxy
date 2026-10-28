/**
 * App Machine - Parent orchestrator for the tmuxy application
 *
 * Coordinates:
 * - Actors (fromCallback, injected via factory):
 *   - tmuxActor: SSE/HTTP lifecycle, state updates
 *   - tmuxStoreActor: optimistic TmuxStore bridge
 *   - keyboardActor: keydown → formatTmuxKey → send-keys
 *   - sizeActor: window.resize, ResizeObserver, char measurement
 *   - linkModifierActor, gestureActor, serversActor
 * - Child Machines (stateful, no DOM access):
 *   - dragMachine: idle/dragging, spawns pointer listener
 *   - resizeMachine: idle/resizing, spawns pointer listener
 */

import {
  setup,
  assign,
  sendTo,
  raise,
  type ActorRefFrom,
  fromCallback,
  type AnyActorRef,
} from 'xstate';
import type { AppMachineContext } from '../types/context';
import type { AllAppMachineEvents } from '../types/events';
import { createInitialContext } from './context';
import { uiPrefsState } from './states/uiPrefs';
import { uiPrefsActions } from './actions/uiPrefs';
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
import { layoutState } from './states/layout';
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
import { connectionGlobalEvents, connectionActions } from './connection';
import { focusAndDragIdleEvents, focusAndDragActions } from './focusAndDrag';
import { reconcileModelActions } from './reconcileModelUpdate';
import { applyFontSize } from '../../utils/fontSizeManager';

import { dragMachine } from '../drag/dragMachine';
import { resizeMachine } from '../resize/resizeMachine';
import type { TmuxStoreActorEvent } from '../actors/tmuxStoreActor';
import type { KeyboardActorEvent } from '../actors/keyboardActor';
import type { TmuxActorEvent } from '../actors/tmuxActor';
import type { SizeActorEvent } from '../actors/sizeActor';
import type { LinkModifierActorEvent } from '../actors/linkModifierActor';
import type { GestureActorEvent } from '../actors/gestureActor';
import type { ServersActorEvent } from '../actors/serversActor';

export const appMachine = setup({
  types: {
    context: {} as AppMachineContext,
    events: {} as AllAppMachineEvents,
  },
  actors: {
    tmuxActor: fromCallback<TmuxActorEvent, { parent: AnyActorRef }>(() => () => {}),
    tmuxStoreActor: fromCallback<TmuxStoreActorEvent, { parent: AnyActorRef }>(() => () => {}),
    keyboardActor: fromCallback<KeyboardActorEvent, { parent: AnyActorRef }>(() => () => {}),
    sizeActor: fromCallback<SizeActorEvent, { parent: AnyActorRef }>(() => () => {}),
    linkModifierActor: fromCallback<LinkModifierActorEvent>(() => () => {}),
    gestureActor: fromCallback<GestureActorEvent, { parent: AnyActorRef }>(() => () => {}),
    serversActor: fromCallback<ServersActorEvent, { parent: AnyActorRef }>(() => () => {}),
    dragMachine,
    resizeMachine,
  },
  actions: {
    ...uiPrefsActions,
    ...commandUiActions,
    ...notificationsActions,
    ...copyModeActions,
    ...groupsAndFloatsActions,
    ...sidebarsActions,
    ...tabOverviewActions,
    ...phoneActions,
    ...gesturesActions,
    ...layoutActions,
    ...dispatchActions,
    ...askActions,
    ...connectionActions,
    ...focusAndDragActions,
    ...reconcileModelActions,
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
      input: ({ self }) => ({ parent: self }),
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
      input: ({ self }) => ({ parent: self }),
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
    ...commandUiState.on,
    ...notificationsState.on,
    ...groupsAndFloatsGlobalEvents,
    ...sidebarsGlobalEvents,
    ...tabOverviewGlobalEvents,
    ...phoneGlobalEvents,
    ...gesturesGlobalEvents,
    ...connectionGlobalEvents,

    TMUX_FATAL: {
      target: '.disconnected',
      actions: assign(({ event }) => ({
        fatalError: event.message,
        connected: false,
      })),
    },
    TMUX_DISCONNECTED: {
      target: '.disconnected',
      actions: assign({ connected: false, enableAnimations: false }),
    },
    TMUX_RECONNECTING: {
      target: '.reconnecting',
      actions: assign({ connected: false }),
    },
    TMUX_DETACHED: {
      target: '.detached',
      actions: assign({ connected: false, enableAnimations: false }),
    },
  },
  states: {
    connecting: {
      on: {
        TMUX_CONNECTED: {
          target: 'idle',
          actions: 'connection_onConnected',
        },
        TMUX_ERROR: {
          actions: assign(({ event }) => ({ error: event.error })),
        },
        KEYBINDINGS_RECEIVED: {
          actions: 'connection_keybindingsReceived',
        },
      },
    },

    idle: {
      on: {
        ...copyModeState.on,
        ...groupsAndFloatsIdleEvents,
        ...sidebarsIdleEvents,
        ...layoutState.on,
        ...askState.on,
        ...focusAndDragIdleEvents,

        TMUX_STATE_UPDATE: {
          actions: sendTo('tmuxStore', ({ event }) => ({
            type: 'RECONCILE_SERVER' as const,
            state: event.state,
          })),
        },
        TMUX_MODEL_UPDATE: {
          actions: 'reconcile_modelUpdate',
        },
        TMUX_ERROR: {
          actions: raise(({ event }) => ({ type: 'NOTIFY' as const, text: event.error })),
        },
        SEND_TMUX_COMMAND: { actions: 'dispatch_command' },
        DISPATCH_OP: { actions: 'dispatch_op' },
        KEYBINDINGS_RECEIVED: {
          actions: 'connection_keybindingsReceived',
        },
      },
    },

    reconnecting: {
      on: {
        TMUX_RECONNECTED: {
          target: 'idle',
          actions: 'connection_onReconnected',
        },
        TMUX_STATE_UPDATE: {
          actions: sendTo('tmuxStore', ({ event }) => ({
            type: 'RECONCILE_SERVER' as const,
            state: event.state,
          })),
        },
        TMUX_MODEL_UPDATE: {
          actions: 'reconcile_reconnectingModelUpdate',
        },
      },
    },

    detached: {
      on: {
        TMUX_CONNECTED: {
          target: 'idle',
          actions: assign({ connected: true, error: null }),
        },
        TMUX_RECONNECTED: {
          target: 'idle',
          actions: assign({ connected: true, error: null }),
        },
        TMUX_STATE_UPDATE: {
          actions: sendTo('tmuxStore', ({ event }) => ({
            type: 'RECONCILE_SERVER' as const,
            state: event.state,
          })),
        },
        TMUX_RECONNECTING: { target: 'reconnecting' },
      },
    },

    disconnected: {
      on: {
        TMUX_RECONNECTING: { target: 'reconnecting' },
        TMUX_CONNECTED: {
          target: 'idle',
          actions: assign({ connected: true, fatalError: null, error: null }),
        },
      },
    },
  },
});

export type AppMachineActor = ActorRefFrom<typeof appMachine>;
