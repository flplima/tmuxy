/**
 * The v86 machine's worker: the emulator and everything that drives it run
 * here, off the page's main thread. Started by `spawnV86Machine`
 * (`machine.ts`); the logic is `machineHost.ts`.
 */
import { serveMachine, type MachineScope } from './machineHost';

serveMachine(self as unknown as MachineScope);
