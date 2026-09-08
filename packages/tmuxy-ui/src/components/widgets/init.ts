import { registerWidget } from './index';
import { browserWidget } from './browser/definition';
import { TmuxyTree } from './TmuxyTree';

registerWidget('browser', browserWidget);
registerWidget('tree', { component: TmuxyTree });
