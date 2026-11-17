/**
 * The widgets this build draws, registered with the registry (registry.ts).
 * Loaded once, for its effect, by App.tsx and by the unit tests' setup: the
 * registry imports no widget, so the widgets may import it.
 */

import { registerWidget } from './registry';
import { TmuxyTree } from './TmuxyTree';
import { previewWidget } from './preview/definition';

registerWidget('tree', { component: TmuxyTree });
registerWidget('preview', previewWidget);
