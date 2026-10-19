import { registerWidget } from './registry';
import { sessionWidget } from './session/definition';
import { TmuxyTree } from './TmuxyTree';

registerWidget('tree', { component: TmuxyTree });
registerWidget('session', sessionWidget);
