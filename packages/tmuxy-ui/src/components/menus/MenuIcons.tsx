import { MENU_ICONS, type MenuIconName } from '../../domain/menus/icons';

const iconProps = {
  className: 'menu-item-icon',
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export function MenuIcon({ name }: { name: MenuIconName }) {
  return (
    <svg {...iconProps} data-icon={name}>
      {MENU_ICONS[name].map((shape, i) => {
        switch (shape[0]) {
          case 'path':
            return <path key={i} d={shape[1]} />;
          case 'rect':
            return (
              <rect
                key={i}
                x={shape[1]}
                y={shape[2]}
                width={shape[3]}
                height={shape[4]}
                rx={shape[5]}
              />
            );
          case 'circle':
            return <circle key={i} cx={shape[1]} cy={shape[2]} r={shape[3]} />;
        }
      })}
    </svg>
  );
}
