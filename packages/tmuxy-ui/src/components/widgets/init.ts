import { registerWidget } from './registry';
import { previewWidget } from './preview/definition';
import { TmuxyTree } from './TmuxyTree';

registerWidget('tree', { component: TmuxyTree });
registerWidget('preview', previewWidget);
