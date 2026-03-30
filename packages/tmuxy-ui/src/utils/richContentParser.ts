/**
 * Rich Content Parser for Terminal Output
 *
 * Parses OSC sequences and image protocols from terminal output:
 * - OSC 8: Hyperlinks
 * - iTerm2 1337: Inline images
 */

// ============================================
// Types
// ============================================

export type RichContentType = 'text' | 'hyperlink' | 'image';

export interface TextContent {
  type: 'text';
  content: string;
}

export interface HyperlinkContent {
  type: 'hyperlink';
  url: string;
  text: string;
  id?: string; // Optional ID for grouping links
}

export interface ImageContent {
  type: 'image';
  protocol: 'iterm2';
  data: string; // Base64 data or data URL
  width?: string;
  height?: string;
  alt?: string;
  preserveAspectRatio?: boolean;
}

export type RichContent = TextContent | HyperlinkContent | ImageContent;

// ============================================
// Parser Functions
// ============================================

/**
 * Parse OSC 8 hyperlink parameters
 */
function parseOsc8Params(params: string): { id?: string } {
  const result: { id?: string } = {};
  if (!params) return result;

  const pairs = params.split(':');
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key === 'id') {
      result.id = value;
    }
  }
  return result;
}

/**
 * Parse iTerm2 image arguments
 */
function parseIterm2Args(args: string): {
  name?: string;
  size?: number;
  width?: string;
  height?: string;
  preserveAspectRatio?: boolean;
  inline?: boolean;
} {
  const result: {
    name?: string;
    size?: number;
    width?: string;
    height?: string;
    preserveAspectRatio?: boolean;
    inline?: boolean;
  } = {};

  const pairs = args.split(';');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;

    const key = pair.slice(0, eqIndex);
    const value = pair.slice(eqIndex + 1);

    switch (key) {
      case 'name':
        // Name is base64 encoded
        try {
          result.name = atob(value);
        } catch {
          result.name = value;
        }
        break;
      case 'size':
        result.size = parseInt(value, 10);
        break;
      case 'width':
        result.width = value;
        break;
      case 'height':
        result.height = value;
        break;
      case 'preserveAspectRatio':
        result.preserveAspectRatio = value === '1';
        break;
      case 'inline':
        result.inline = value === '1';
        break;
    }
  }

  return result;
}

/**
 * Parse a single line of terminal output for rich content
 */
export function parseRichContent(line: string): RichContent[] {
  const result: RichContent[] = [];
  let lastIndex = 0;

  // Combine all patterns and process in order
  type Match = {
    type: 'osc8' | 'iterm2';
    index: number;
    length: number;
    data: RegExpMatchArray;
  };

  const matches: Match[] = [];

  // Find OSC 8 hyperlinks
  const osc8Regex =
    /\x1b\]8;([^;]*);([^\x07\x1b]*?)(?:\x07|\x1b\\)([\s\S]*?)\x1b\]8;;(?:\x07|\x1b\\)/g;
  let match;
  while ((match = osc8Regex.exec(line)) !== null) {
    matches.push({
      type: 'osc8',
      index: match.index,
      length: match[0].length,
      data: match,
    });
  }

  // Find iTerm2 images
  const iterm2Regex = /\x1b\]1337;File=([^:]*):([^\x07]*)\x07/g;
  while ((match = iterm2Regex.exec(line)) !== null) {
    matches.push({
      type: 'iterm2',
      index: match.index,
      length: match[0].length,
      data: match,
    });
  }

  // Sort matches by index
  matches.sort((a, b) => a.index - b.index);

  // Process matches in order
  for (const m of matches) {
    // Add text before this match
    if (m.index > lastIndex) {
      const text = line.slice(lastIndex, m.index);
      if (text) {
        result.push({ type: 'text', content: text });
      }
    }

    switch (m.type) {
      case 'osc8': {
        const params = parseOsc8Params(m.data[1]);
        const url = m.data[2];
        const text = m.data[3];

        if (url && text) {
          result.push({
            type: 'hyperlink',
            url,
            text,
            id: params.id,
          });
        }
        break;
      }

      case 'iterm2': {
        const args = parseIterm2Args(m.data[1]);
        const base64Data = m.data[2];

        if (base64Data && args.inline !== false) {
          // Detect image type from data or default to PNG
          let mimeType = 'image/png';
          try {
            const decoded = atob(base64Data.slice(0, 16));
            if (decoded.startsWith('\x89PNG')) {
              mimeType = 'image/png';
            } else if (decoded.startsWith('\xff\xd8\xff')) {
              mimeType = 'image/jpeg';
            } else if (decoded.startsWith('GIF')) {
              mimeType = 'image/gif';
            } else if (decoded.startsWith('RIFF') && decoded.includes('WEBP')) {
              mimeType = 'image/webp';
            }
          } catch {
            // Ignore decode errors
          }

          result.push({
            type: 'image',
            protocol: 'iterm2',
            data: `data:${mimeType};base64,${base64Data}`,
            width: args.width,
            height: args.height,
            alt: args.name,
            preserveAspectRatio: args.preserveAspectRatio,
          });
        }
        break;
      }
    }

    lastIndex = m.index + m.length;
  }

  // Add remaining text
  if (lastIndex < line.length) {
    const text = line.slice(lastIndex);
    if (text) {
      result.push({ type: 'text', content: text });
    }
  }

  // If no matches were found, return the whole line as text
  if (result.length === 0 && line) {
    result.push({ type: 'text', content: line });
  }

  return result;
}

/**
 * Check if a line contains any rich content (for optimization)
 */
export function hasRichContent(line: string): boolean {
  // Quick check for escape sequences that might contain rich content
  return (
    line.includes('\x1b]8;') || // OSC 8
    line.includes('\x1b]1337;') // iTerm2
  );
}

/**
 * Strip all rich content sequences from a line (for plain text fallback)
 */
export function stripRichContent(line: string): string {
  return line
    .replace(/\x1b\]8;[^;]*;[^\x07\x1b]*?(?:\x07|\x1b\\)/g, '') // OSC 8 open
    .replace(/\x1b\]8;;(?:\x07|\x1b\\)/g, '') // OSC 8 close
    .replace(/\x1b\]1337;File=[^:]*:[^\x07]*\x07/g, ''); // iTerm2
}
