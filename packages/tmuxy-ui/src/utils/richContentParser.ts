/**
 * Rich Content Parser for Terminal Output
 *
 * Parses OSC sequences and image protocols from terminal output:
 * - OSC 8: Hyperlinks
 * - iTerm2 1337: Inline images
 * - Kitty Graphics Protocol (APC sequences)
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
  protocol: 'iterm2' | 'kitty';
  data: string; // Base64 data or data URL
  width?: string;
  height?: string;
  alt?: string;
  preserveAspectRatio?: boolean;
}

export type RichContent = TextContent | HyperlinkContent | ImageContent;

// ============================================
// Kitty Graphics State
// ============================================

interface KittyImageState {
  id: number;
  chunks: string[];
  format?: number; // 24=RGB, 32=RGBA, 100=PNG
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
}

// Global state for Kitty images (since they can span multiple sequences)
const kittyImages: Map<number, KittyImageState> = new Map();
let kittyNextId = 1;

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
 * Parse Kitty graphics control data
 */
function parseKittyControl(control: string): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  const pairs = control.split(',');

  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;

    const key = pair.slice(0, eqIndex);
    const value = pair.slice(eqIndex + 1);

    // Try to parse as number
    const numValue = parseInt(value, 10);
    result[key] = isNaN(numValue) ? value : numValue;
  }

  return result;
}

/**
 * Get MIME type from Kitty format code
 */
function getKittyMimeType(format: number): string {
  switch (format) {
    case 100:
      return 'image/png';
    case 24:
    case 32:
      return 'image/raw'; // Raw RGB/RGBA - would need conversion
    default:
      return 'image/png';
  }
}

/**
 * Process a Kitty graphics sequence and return an image if complete
 */
function processKittySequence(
  control: Record<string, string | number>,
  payload: string,
): ImageContent | null {
  const action = (control.a as string) || 't'; // Default action is transmit
  const imageId = (control.i as number) || kittyNextId++;
  const more = control.m as number; // 1 = more chunks, 0 = final

  if (action === 't' || action === 'T') {
    // Transmit image data
    let state = kittyImages.get(imageId);

    if (!state) {
      state = {
        id: imageId,
        chunks: [],
        format: (control.f as number) || 32,
        width: control.s as number,
        height: control.v as number,
        displayWidth: control.c as number,
        displayHeight: control.r as number,
      };
      kittyImages.set(imageId, state);
    }

    if (payload) {
      state.chunks.push(payload);
    }

    // If this is the final chunk (m=0 or m not specified with data)
    if (more !== 1 && state.chunks.length > 0) {
      const fullData = state.chunks.join('');
      const mimeType = getKittyMimeType(state.format || 100);

      // Clean up state
      kittyImages.delete(imageId);

      return {
        type: 'image',
        protocol: 'kitty',
        data: `data:${mimeType};base64,${fullData}`,
        width: state.displayWidth ? `${state.displayWidth}ch` : undefined,
        height: state.displayHeight ? `${state.displayHeight}em` : undefined,
      };
    }
  } else if (action === 'p') {
    // Display a previously transmitted image
    const state = kittyImages.get(imageId);
    if (state && state.chunks.length > 0) {
      const fullData = state.chunks.join('');
      const mimeType = getKittyMimeType(state.format || 100);

      return {
        type: 'image',
        protocol: 'kitty',
        data: `data:${mimeType};base64,${fullData}`,
        width: state.displayWidth ? `${state.displayWidth}ch` : undefined,
        height: state.displayHeight ? `${state.displayHeight}em` : undefined,
      };
    }
  } else if (action === 'd') {
    // Delete image
    if (imageId) {
      kittyImages.delete(imageId);
    } else {
      // Delete all images
      kittyImages.clear();
    }
  }

  return null;
}

/**
 * Parse a single line of terminal output for rich content
 */
export function parseRichContent(line: string): RichContent[] {
  const result: RichContent[] = [];
  let lastIndex = 0;

  // Combine all patterns and process in order
  type Match = {
    type: 'osc8' | 'iterm2' | 'kitty';
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

  // Find Kitty graphics
  const kittyRegex = /\x1b_G([^;\x1b]*?)(?:;([^\x1b]*))?\x1b\\/g;
  while ((match = kittyRegex.exec(line)) !== null) {
    matches.push({
      type: 'kitty',
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

      case 'kitty': {
        const control = parseKittyControl(m.data[1] || '');
        const payload = m.data[2] || '';
        const image = processKittySequence(control, payload);
        if (image) {
          result.push(image);
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
    line.includes('\x1b]1337;') || // iTerm2
    line.includes('\x1b_G') // Kitty
  );
}

/**
 * Strip all rich content sequences from a line (for plain text fallback)
 */
export function stripRichContent(line: string): string {
  return line
    .replace(/\x1b\]8;[^;]*;[^\x07\x1b]*?(?:\x07|\x1b\\)/g, '') // OSC 8 open
    .replace(/\x1b\]8;;(?:\x07|\x1b\\)/g, '') // OSC 8 close
    .replace(/\x1b\]1337;File=[^:]*:[^\x07]*\x07/g, '') // iTerm2
    .replace(/\x1b_G[^\x1b]*\x1b\\/g, ''); // Kitty
}

/**
 * Clear Kitty image cache (call on terminal reset)
 */
export function clearKittyCache(): void {
  kittyImages.clear();
  kittyNextId = 1;
}
