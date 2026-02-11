# Implement `tmuxy view` command

## Summary
Create a `tmuxy view` command that renders images, markdown, or web content directly in a terminal pane, similar to Wave Terminal's block system.

## Research Summary (Wave Terminal Reference)

### How Wave Does It
- **Block System**: Different view types (term, preview, web, waveai) share the same tab space
- **Preview Blocks**: Auto-detect MIME types, render images/markdown/code inline
- **Web Blocks**: Embedded Chromium browser for full web browsing
- **Unified UX**: Escape key closes views, consistent navigation
- **State Management**: Jotai atoms for reactive state, metadata persists per-block
- **File Streaming**: 64KB chunks for large files
- **Monaco Editor**: Web workers for syntax highlighting in code blocks

### Key UX Patterns
- `wsh view <path>` opens file preview
- `wsh web open <url>` opens web content
- Escape closes the view and returns to terminal
- Views are full-pane (no terminal visible while view is active)

## Proposed Implementation

### CLI Command: `tmuxy view <arg>`

```bash
# Images
tmuxy view myimage.jpg
tmuxy view ./screenshot.png

# Markdown
tmuxy view /docs/README.md
tmuxy view notes.md

# URLs (auto-detected)
tmuxy view localhost:3000
tmuxy view example.com
tmuxy view https://github.com/user/repo
```

### Argument Resolution
1. Check if arg is a valid file path that exists
2. If file exists:
   - Image extensions (.jpg, .png, .gif, .svg, .webp) → image view
   - Markdown extensions (.md, .markdown) → markdown view
   - Other → unsupported, show error
3. If not a file OR file doesn't exist AND looks like URL:
   - Add `https://` prefix if no protocol
   - Open as web view

### Tmux-Side Implementation

The `tmuxy view` command runs in the terminal and outputs structured data:

```bash
# For images - output base64
tmuxy view image.png
# Outputs: __TMUXY_VIEW_IMAGE__
# <base64 encoded image data>
# __TMUXY_VIEW_END__

# For markdown - output raw content
tmuxy view readme.md
# Outputs: __TMUXY_VIEW_MARKDOWN__
# <raw markdown content>
# __TMUXY_VIEW_END__

# For URLs - output normalized URL
tmuxy view example.com
# Outputs: __TMUXY_VIEW_URL__
# https://example.com
# __TMUXY_VIEW_END__
```

The command then waits for input (blocking). Pressing Escape sends a signal that terminates the process.

### UI-Side Implementation

#### Detection
- Parse pane content for `__TMUXY_VIEW_*__` markers
- When detected, switch pane to view mode
- Extract content between markers

#### Image View
- Render `<img>` tag with `src="data:image/...;base64,{content}"`
- Center image in pane
- Scale to fit while maintaining aspect ratio
- Support zoom with scroll wheel (optional)

#### Markdown View
- Use a markdown renderer (react-markdown, marked, or similar)
- Styling:
  - Sans-serif font (system font stack)
  - Proper heading hierarchy
  - Code blocks with syntax highlighting (highlight.js or Prism)
  - Mermaid.js support for diagrams
  - Native browser scrollbar
  - Dark theme matching terminal
- Container has padding and max-width for readability

#### Web View
- Render `<iframe>` or `<webview>` with the URL
- Full pane size
- Handle security considerations (sandbox attribute)
- Show loading indicator
- Handle navigation within iframe

#### View Mode State
- `pane.viewMode`: `'terminal' | 'image' | 'markdown' | 'web'`
- `pane.viewContent`: The extracted content/URL
- When in view mode, terminal content is hidden (not destroyed)

#### Exit Handling
- Listen for Escape keypress in view mode
- Send signal to terminate `tmuxy view` process
- Clear view markers from terminal
- Return to normal terminal mode

### Components

```
ViewOverlay.tsx          - Wrapper that detects view mode and renders appropriate view
ImageView.tsx            - Image renderer with scaling
MarkdownView.tsx         - Markdown renderer with syntax highlighting
WebView.tsx              - iframe/webview wrapper
```

### Markdown Renderer Features
- GitHub Flavored Markdown (GFM)
- Syntax highlighting for code blocks (common languages)
- Mermaid diagram support
- Tables
- Task lists
- Auto-linking URLs
- Image rendering (relative paths resolved)

### Security Considerations
- Sanitize markdown HTML output
- Sandbox iframes appropriately
- Validate URLs before loading
- Consider CSP headers for web views

## Success Criteria

### CLI
- [ ] `tmuxy view image.png` outputs base64-encoded image with markers
- [ ] `tmuxy view readme.md` outputs raw markdown with markers
- [ ] `tmuxy view example.com` outputs normalized URL with markers
- [ ] Command blocks until terminated (Escape or signal)
- [ ] Graceful handling of missing files / invalid URLs

### Image View
- [ ] Images render centered in pane
- [ ] Images scale to fit pane dimensions
- [ ] Supports common formats (jpg, png, gif, svg, webp)
- [ ] Large images handled efficiently

### Markdown View
- [ ] Markdown renders with proper formatting
- [ ] Sans-serif font, dark theme
- [ ] Code blocks have syntax highlighting
- [ ] Mermaid diagrams render correctly
- [ ] Native scrollbar for long documents
- [ ] Links are clickable (open in browser or navigate)

### Web View
- [ ] URLs load in embedded iframe/webview
- [ ] Full pane rendering
- [ ] Loading indicator shown
- [ ] Basic navigation works within view

### General
- [ ] Escape key closes view and returns to terminal
- [ ] Terminal content preserved during view mode
- [ ] View state doesn't persist after close
- [ ] Multiple panes can have different view modes simultaneously

## References
- [Wave Terminal Docs](https://docs.waveterm.dev/)
- [Wave Terminal wsh command](https://docs.waveterm.dev/wsh)
- [Wave Block System](https://deepwiki.com/wavetermdev/waveterm/3-block-system)
- [react-markdown](https://github.com/remarkjs/react-markdown)
- [Mermaid.js](https://mermaid.js.org/)
