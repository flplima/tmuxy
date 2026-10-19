/**
 * A menu icon (`domain/menus/icons.ts`) as an image a native menu item can
 * carry: the same strokes the in-app menu draws, rasterised in the page.
 *
 * muda hands the platform a plain bitmap — no template image the system
 * recolours — so the strokes are drawn in the menu's own text colour for the
 * system appearance at the time the menu is built. A menu built in dark mode
 * keeps its light strokes until it is built again; the menu bar rebuilds on
 * an appearance change (`NativeMenuBar`), and a popup is built on every open.
 */

import type { Image } from '@tauri-apps/api/image';
import { menuIconSvg, type MenuIconName } from '../../domain/menus/icons';
import { resolveThemeMode } from '../../utils/themeManager';

/** muda draws a menu item's image 18pt tall: twice that, for a Retina screen. */
const SIZE = 36;

/** The menu's text colour, light on a dark menu and dark on a light one. */
const STROKE = { dark: 'rgba(255, 255, 255, 0.85)', light: 'rgba(0, 0, 0, 0.85)' } as const;

const images = new Map<string, Promise<Image | null>>();

/** The icon's image for the current appearance, or null where none can be drawn. */
export function nativeMenuIcon(name: MenuIconName): Promise<Image | null> {
  const mode = resolveThemeMode('auto');
  const key = `${name}:${mode}`;
  let image = images.get(key);
  if (!image) {
    image = rasterize(menuIconSvg(name, STROKE[mode], SIZE)).catch(() => null);
    images.set(key, image);
  }
  return image;
}

async function rasterize(svg: string): Promise<Image | null> {
  const img = new window.Image(SIZE, SIZE);
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(img, 0, 0, SIZE, SIZE);
  const { data } = context.getImageData(0, 0, SIZE, SIZE);
  const { Image } = await import('@tauri-apps/api/image');
  return Image.new(new Uint8Array(data.buffer), SIZE, SIZE);
}
