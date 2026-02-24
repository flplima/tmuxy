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

  // Extract the last image URL or data URI.
  // Terminal line wrapping joins content without spaces, so multiple data URIs
  // concatenate directly (e.g., "...ggg==data:image/png..."). We use a specific
  // base64 data URI pattern to avoid matching across URI boundaries.
  const dataPattern = /data:image\/[^;]+;base64,[A-Za-z0-9+/]+=*/g;
  const httpPattern = /https?:\/\/[^\s]+\.(?:png|jpe?g|gif|webp|svg|bmp|ico)(?:\?[^\s]*)?/gi;
  let src = '';
  let match;
  while ((match = dataPattern.exec(joined)) !== null) {
    src = match[0];
  }
  if (!src) {
    while ((match = httpPattern.exec(joined)) !== null) {
      src = match[0];
    }
  }

  if (!src) {
    return <div className="widget-image-empty">Waiting for image...</div>;
  }

  return (
    <div
      className="widget-image"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <img
        src={src}
        alt="Widget image"
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          minWidth: 32,
          minHeight: 32,
          objectFit: 'contain',
          imageRendering: 'auto',
        }}
      />
    </div>
  );
}
