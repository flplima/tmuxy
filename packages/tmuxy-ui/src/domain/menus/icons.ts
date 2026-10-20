/**
 * The line icons menu items carry, as data: each one a few strokes on a 16×16
 * grid. Both renderers draw from this table — the in-app menu as inline SVG
 * (`components/menus/MenuIcons.tsx`), the desktop's native menus as a bitmap
 * rasterised from the same strokes (`infra/menus/nativeIcons.ts`) — so an
 * item looks the same in either.
 */

type Shape =
  | readonly ['path', string]
  | readonly ['rect', number, number, number, number, number]
  | readonly ['circle', number, number, number];

/** The pane frame the split and layout icons draw their dividers in. */
const FRAME: Shape = ['rect', 2, 2.5, 12, 11, 1.5];

export const MENU_ICONS = {
  // Two sheets, one over the other.
  copy: [
    ['rect', 5.5, 5.5, 8, 8, 1.5],
    ['path', 'M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2'],
  ],
  // A keyboard: the text goes to the program as if typed.
  'send-keys': [
    ['rect', 1.5, 4, 13, 8.5, 1.5],
    ['path', 'M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M4 9.5h.01M11.5 9.5h.01M6.5 9.5h3'],
  ],
  paste: [
    ['rect', 3.5, 3, 9, 11, 1.5],
    ['rect', 6, 1.5, 4, 3, 1],
  ],
  'split-below': [FRAME, ['path', 'M2 8h12']],
  'split-right': [FRAME, ['path', 'M8 2.5v11']],
  'layout-even-horizontal': [FRAME, ['path', 'M6 2.5v11M10 2.5v11']],
  'layout-even-vertical': [FRAME, ['path', 'M2 6.2h12M2 9.8h12']],
  'layout-main-horizontal': [FRAME, ['path', 'M2 8.5h12M8 8.5v5']],
  'layout-main-vertical': [FRAME, ['path', 'M8.5 2.5v11M8.5 8h5.5']],
  'layout-tiled': [FRAME, ['path', 'M8 2.5v11M2 8h12']],
  // Four corners pushed out.
  zoom: [['path', 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10']],
  next: [['path', 'M6 3.5L10.5 8 6 12.5']],
  previous: [['path', 'M10 3.5L5.5 8 10 12.5']],
  swap: [['path', 'M3 5.5h10M10.5 3l2.5 2.5L10.5 8M13 10.5H3M5.5 8L3 10.5 5.5 13']],
  mark: [['path', 'M4.5 2.5h7v11L8 11l-3.5 2.5z']],
  // An arrow into a pane.
  join: [['path', 'M2.5 8h7M7 5.5L9.5 8 7 10.5M9.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3']],
  // An arrow out of a pane.
  'move-out': [
    [
      'path',
      'M9 2.5h4.5V7M13.5 2.5L8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3',
    ],
  ],
  // Panes stacked as one.
  group: [['path', 'M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8.5l5.5 3 5.5-3M2.5 11.5l5.5 3 5.5-3']],
  // Lines of text: the screen's history to move through.
  'copy-mode': [['path', 'M2.5 4h11M2.5 8h7M2.5 12h9']],
  clear: [
    [
      'path',
      'M5.5 13.5L2.6 10.6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.4 0l3.1 3.1a1 1 0 0 1 0 1.4l-6.3 5.8zM6 6.5l4 4M7.5 13.5h6',
    ],
  ],
  new: [['path', 'M8 3v10M3 8h10']],
  close: [['path', 'M4 4l8 8M12 4l-8 8']],
  rename: [['path', 'M10.5 2.5l3 3L6 13H3v-3zM9 4l3 3']],
  tabs: [
    ['rect', 2.5, 2.5, 4.5, 4.5, 1],
    ['rect', 9, 2.5, 4.5, 4.5, 1],
    ['rect', 2.5, 9, 4.5, 4.5, 1],
    ['rect', 9, 9, 4.5, 4.5, 1],
  ],
  detach: [['path', 'M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6M10.5 11l3-3-3-3M13.5 8H6']],
  trash: [
    [
      'path',
      'M2.5 4.5h11M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4.5',
    ],
  ],
  // A globe: a session on another machine.
  connect: [
    ['circle', 8, 8, 5.75],
    [
      'path',
      'M2.25 8h11.5M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75M8 2.25C6.4 3.85 5.6 5.75 5.6 8s.8 4.15 2.4 5.75',
    ],
  ],
  'text-bigger': [
    ['circle', 7, 7, 4.5],
    ['path', 'M13.5 13.5l-3.3-3.3M7 5v4M5 7h4'],
  ],
  'text-smaller': [
    ['circle', 7, 7, 4.5],
    ['path', 'M13.5 13.5l-3.3-3.3M5 7h4'],
  ],
  'text-normal': [
    ['circle', 7, 7, 4.5],
    ['path', 'M13.5 13.5l-3.3-3.3'],
  ],
  file: [['path', 'M9.5 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5zM9.5 2v3h3']],
  reload: [['path', 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3']],
  restart: [
    [
      'path',
      'M2.5 8a5.5 5.5 0 0 1 9.4-3.9l1.6 1.4M13.5 2.5v3h-3M13.5 8a5.5 5.5 0 0 1-9.4 3.9l-1.6-1.4M2.5 13.5v-3h3',
    ],
  ],
  quit: [['path', 'M8 2v6M4.5 4.2a5 5 0 1 0 7 0']],
  // What a checked checkbox or the chosen radio item shows.
  check: [['path', 'M3.5 8.5l3 3 6-7']],
} as const satisfies Record<string, readonly Shape[]>;

export type MenuIconName = keyof typeof MENU_ICONS;

/** An icon as a standalone SVG document, stroked in `color`, `size` pixels square. */
export function menuIconSvg(name: MenuIconName, color: string, size: number): string {
  const shapes = (MENU_ICONS[name] as readonly Shape[]).map((shape) => {
    switch (shape[0]) {
      case 'path':
        return `<path d="${shape[1]}"/>`;
      case 'rect':
        return `<rect x="${shape[1]}" y="${shape[2]}" width="${shape[3]}" height="${shape[4]}" rx="${shape[5]}"/>`;
      case 'circle':
        return `<circle cx="${shape[1]}" cy="${shape[2]}" r="${shape[3]}"/>`;
    }
  });
  // A pixel of margin each side: the native menu draws the image at its full
  // height, and the strokes touch the 16×16 grid's edge.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 18 18" width="${size}" height="${size}" ` +
    `fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
    `${shapes.join('')}</svg>`
  );
}
