import type { WidgetProps } from './index';

/**
 * Image widget — renders an <img> from the last URL/data-URI in the pane content.
 *
 * Terminal line wrapping can split a long URL across multiple CellLines,
 * so we join all content lines and extract the last URL-like string.
 */
export function TmuxyImage({ lines }: WidgetProps) {
  // Join all content lines (handles terminal line wrapping of long URLs)
  const joined = lines.join('').trim();

  // Find the last URL or data URI (search backwards for http/data: prefix)
  const urlPattern = /(?:https?:\/\/|data:)[^\s]+/g;
  let src = '';
  let match;
  while ((match = urlPattern.exec(joined)) !== null) {
    src = match[0];
  }

  if (!src) {
    return <div className="widget-image-empty">Waiting for image...</div>;
  }

  return (
    <div className="widget-image" style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <img src={src} alt="Widget image" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
    </div>
  );
}
