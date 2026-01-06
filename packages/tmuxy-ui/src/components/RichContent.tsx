/**
 * RichContent Component
 *
 * Renders rich terminal content including:
 * - OSC 8 hyperlinks
 * - iTerm2 inline images
 * - Kitty Graphics Protocol images
 */

import { useState, useCallback } from 'react';
import type { RichContent as RichContentType, ImageContent, HyperlinkContent } from '../utils/richContentParser';
import './RichContent.css';

// ============================================
// Image Component
// ============================================

interface RichImageProps {
  image: ImageContent;
}

function RichImage({ image }: RichImageProps) {
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const handleError = useCallback(() => {
    setError(true);
  }, []);

  const handleLoad = useCallback(() => {
    setLoaded(true);
  }, []);

  if (error) {
    return (
      <span className="rich-image-error" title="Failed to load image">
        [IMG]
      </span>
    );
  }

  // Parse dimensions
  const style: React.CSSProperties = {};

  if (image.width) {
    if (image.width.endsWith('%')) {
      style.width = image.width;
    } else if (image.width.endsWith('px')) {
      style.width = image.width;
    } else if (image.width.endsWith('ch')) {
      style.width = image.width;
    } else if (image.width === 'auto') {
      style.width = 'auto';
    } else {
      // Assume cells - convert to ch units
      const cells = parseInt(image.width, 10);
      if (!isNaN(cells)) {
        style.width = `${cells}ch`;
      }
    }
  }

  if (image.height) {
    if (image.height.endsWith('%')) {
      style.height = image.height;
    } else if (image.height.endsWith('px')) {
      style.height = image.height;
    } else if (image.height.endsWith('em')) {
      style.height = image.height;
    } else if (image.height === 'auto') {
      style.height = 'auto';
    } else {
      // Assume cells - convert to line height
      const cells = parseInt(image.height, 10);
      if (!isNaN(cells)) {
        style.height = `${cells * 1.2}em`;
      }
    }
  }

  // Default max dimensions to prevent huge images
  if (!style.maxWidth) {
    style.maxWidth = '100%';
  }
  if (!style.maxHeight) {
    style.maxHeight = '300px';
  }

  return (
    <span className={`rich-image-container ${loaded ? 'rich-image-loaded' : ''}`}>
      <img
        src={image.data}
        alt={image.alt || 'Terminal image'}
        style={style}
        onError={handleError}
        onLoad={handleLoad}
        className="rich-image"
        loading="lazy"
      />
    </span>
  );
}

// ============================================
// Hyperlink Component
// ============================================

interface RichHyperlinkProps {
  link: HyperlinkContent;
  children?: React.ReactNode;
}

function RichHyperlink({ link, children }: RichHyperlinkProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Open in new tab
      e.preventDefault();
      window.open(link.url, '_blank', 'noopener,noreferrer');
    },
    [link.url]
  );

  // Validate URL for security
  let isValidUrl = false;
  try {
    const url = new URL(link.url);
    // Only allow http, https, and mailto protocols
    isValidUrl = ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch {
    isValidUrl = false;
  }

  if (!isValidUrl) {
    // Render as plain text if URL is invalid/unsafe
    return <span className="rich-link-invalid">{children || link.text}</span>;
  }

  return (
    <a
      href={link.url}
      onClick={handleClick}
      className="rich-link"
      title={link.url}
      data-link-id={link.id}
    >
      {children || link.text}
    </a>
  );
}

// ============================================
// Main RichContent Component
// ============================================

interface RichContentProps {
  content: RichContentType;
  renderText?: (text: string) => React.ReactNode;
}

export function RichContent({ content, renderText }: RichContentProps) {
  switch (content.type) {
    case 'text':
      return <>{renderText ? renderText(content.content) : content.content}</>;

    case 'hyperlink':
      return (
        <RichHyperlink link={content}>
          {renderText ? renderText(content.text) : content.text}
        </RichHyperlink>
      );

    case 'image':
      return <RichImage image={content} />;

    default:
      return null;
  }
}

// ============================================
// Rich Content Line Component
// ============================================

interface RichContentLineProps {
  contents: RichContentType[];
  renderText?: (text: string) => React.ReactNode;
}

export function RichContentLine({ contents, renderText }: RichContentLineProps) {
  if (contents.length === 0) {
    return null;
  }

  return (
    <>
      {contents.map((content, index) => (
        <RichContent key={index} content={content} renderText={renderText} />
      ))}
    </>
  );
}

export default RichContent;
