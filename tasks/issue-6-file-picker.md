# Add file picker

## Summary
Add a side drawer with a file tree browser that allows selecting files and inserting their paths into the active pane.

## UI Design

### Toggle Button
- New button at the **left side of the status bar**, before the window tabs
- Icon: folder icon (e.g., `fa-folder` or `fa-folder-open`)
- Clicking toggles the side drawer open/closed

### Side Drawer
- Slides in from the left side
- Width: ~250-300px
- Shows file tree rooted at the active pane's current working directory
- Standard browser-native tree view styling:
  - Folders expandable/collapsible with arrow icons
  - File icons based on extension (optional)
  - Indentation for hierarchy
  - Hover highlight
  - Selected item highlight

### File Tree Behavior
- Root directory: `pane.cwd` (current working directory of active pane)
- Folders: click to expand/collapse
- Files: click to select, double-click or Enter to confirm

## Interactions

### Opening
- Click the folder button in status bar
- Keyboard shortcut (optional): `Prefix + e` or similar

### Navigation
- Arrow keys to navigate tree
- Enter to expand folder / confirm file selection
- Left/Right to collapse/expand folders
- Home/End to jump to first/last item

### Selection
- **Double-click on file**: Insert path and close drawer
- **Press Enter on file**: Insert path and close drawer
- **Press Enter on folder**: Expand/collapse folder

### Closing
- Press **Escape**: Close drawer without action
- Click **outside drawer**: Close drawer without action
- Click **toggle button**: Close drawer
- **After file selection**: Auto-close

### Path Insertion
- When file is selected, send the **full absolute path** as text input to the active pane
- Uses `send-keys` to type the path into the terminal
- Path should be properly escaped for shell use (spaces, special chars)

## Implementation

### Backend
- New command: `get_directory_listing`
  - Input: directory path
  - Output: list of entries with name, type (file/dir), and path
- Could use Rust's `std::fs::read_dir` or similar

### Frontend Components
```
FilePicker.tsx           - Main drawer component
FileTree.tsx             - Recursive tree renderer
FileTreeItem.tsx         - Single file/folder item
```

### State
- `filePickerOpen`: boolean
- `filePickerRoot`: string (directory path)
- `filePickerExpanded`: Set<string> (expanded folder paths)
- `filePickerSelected`: string | null (selected item path)

### Styling
- Dark theme matching app
- Monospace font for paths
- Subtle borders/separators
- Smooth slide-in animation

## Success Criteria
- [ ] Folder button appears in status bar before window tabs
- [ ] Clicking button toggles side drawer
- [ ] File tree shows contents of active pane's cwd
- [ ] Folders can be expanded/collapsed
- [ ] Double-click on file inserts full path to active pane
- [ ] Enter key on file inserts full path to active pane
- [ ] Escape closes drawer without action
- [ ] Clicking outside drawer closes it
- [ ] Drawer closes automatically after file selection
- [ ] File paths are properly shell-escaped
- [ ] Keyboard navigation works (arrows, enter, escape)
- [ ] Tree updates if active pane changes (new cwd)
