/**
 * The menu icons as the native menus get them: a standalone SVG document per
 * icon, which the page rasterises (`infra/menus/nativeIcons.ts`). A document
 * that does not parse draws nothing, and the item silently goes without.
 */

import { describe, it, expect } from 'vitest';
import { MENU_ICONS, menuIconSvg, type MenuIconName } from '../icons';

describe('menuIconSvg', () => {
  it.each(Object.keys(MENU_ICONS) as MenuIconName[])(
    '%s is a parsable SVG of its strokes',
    (name) => {
      const doc = new DOMParser().parseFromString(
        menuIconSvg(name, '#123456', 36),
        'image/svg+xml',
      );
      const svg = doc.documentElement;
      expect(svg.nodeName).toBe('svg');
      expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
      expect(svg.getAttribute('width')).toBe('36');
      expect(svg.getAttribute('stroke')).toBe('#123456');
      expect(svg.children).toHaveLength(MENU_ICONS[name].length);
    },
  );
});
