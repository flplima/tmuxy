import { registerWidget } from './registry';
import { sessionWidget } from './session/definition';
import { previewWidget } from './preview/definition';
import { TmuxyTree } from './TmuxyTree';

registerWidget('tree', { component: TmuxyTree });
registerWidget('session', sessionWidget);
registerWidget('preview', previewWidget);
