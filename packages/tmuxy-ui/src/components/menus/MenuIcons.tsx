/**
 * The small line icons menu items carry, drawn inline so they take the
 * item's colour (muted at rest, full on hover — see `.menu-item-icon`).
 */

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

/** Two sheets, one over the other. */
export function CopyIcon() {
  return (
    <svg {...iconProps}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

/** A keyboard: the text goes to the program as if typed. */
export function SendKeysIcon() {
  return (
    <svg {...iconProps}>
      <rect x="1.5" y="4" width="13" height="8.5" rx="1.5" />
      <path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M4 9.5h.01M11.5 9.5h.01M6.5 9.5h3" />
    </svg>
  );
}
