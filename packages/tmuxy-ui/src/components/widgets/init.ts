import { registerWidget } from './index';
import { browserWidget } from './browser/definition';
import { sessionWidget } from './session/definition';
import { TmuxyTree } from './TmuxyTree';

registerWidget('browser', browserWidget);
registerWidget('tree', { component: TmuxyTree });
registerWidget('session', sessionWidget);
