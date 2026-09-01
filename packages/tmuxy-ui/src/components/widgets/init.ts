import { registerWidget } from './index';
import { TmuxyImage } from './TmuxyImage';
import { TmuxyMarkdown } from './TmuxyMarkdown';
import { TmuxyTree } from './TmuxyTree';

registerWidget('image', TmuxyImage);
registerWidget('markdown', TmuxyMarkdown);
registerWidget('tree', TmuxyTree);
