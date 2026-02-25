/**
 * FilePicker - Side drawer with file tree browser
 *
 * Allows selecting files and inserting their paths into the active pane.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppSend, useAppSelector } from '../machines/AppContext';

interface DirectoryEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
}

interface FilePickerProps {
  isOpen: boolean;
  onClose: () => void;
  rootPath: string;
}

export function FilePicker({ isOpen, onClose, rootPath }: FilePickerProps) {
  const send = useAppSend();
  const activePaneId = useAppSelector((ctx) => ctx.activePaneId);

  const [currentPath, setCurrentPath] = useState(rootPath);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Load directory contents
  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);

    try {
      // Use the HTTP API for directory listing
      const response = await fetch('/api/directory?path=' + encodeURIComponent(path));
      if (!response.ok) {
        throw new Error('Failed to load directory');
      }
      const data = await response.json();
      setEntries(data);
      setCurrentPath(path);
      setSelectedIndex(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load initial directory when opened
  useEffect(() => {
    if (isOpen) {
      loadDirectory(rootPath);
    }
  }, [isOpen, rootPath, loadDirectory]);

  // Handle keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(0, i - 1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(entries.length - 1, i + 1));
          break;
        case 'Enter':
          e.preventDefault();
          if (entries[selectedIndex]) {
            handleEntryClick(entries[selectedIndex]);
          }
          break;
        case 'Backspace':
          e.preventDefault();
          goUp();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, entries, selectedIndex, onClose]);

  // Handle click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Small delay to prevent immediate close from the toggle click
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  const handleEntryClick = (entry: DirectoryEntry) => {
    if (entry.is_dir) {
      loadDirectory(entry.path);
    } else {
      selectFile(entry.path);
    }
  };

  const handleEntryDoubleClick = (entry: DirectoryEntry) => {
    if (!entry.is_dir) {
      selectFile(entry.path);
    }
  };

  const selectFile = (path: string) => {
    if (activePaneId) {
      send({ type: 'WRITE_TO_PANE', paneId: activePaneId, data: path });
    }
    onClose();
  };

  const goUp = () => {
    const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/';
    loadDirectory(parentPath);
  };

  if (!isOpen) return null;

  return (
    <div className="file-picker-overlay">
      <div className="file-picker" ref={drawerRef}>
        <div className="file-picker-header">
          <button className="file-picker-up" onClick={goUp} title="Go up">
            <i className="fa fa-level-up" />
          </button>
          <span className="file-picker-path" title={currentPath}>
            {currentPath}
          </span>
          <button className="file-picker-close" onClick={onClose} title="Close">
            <i className="fa fa-times" />
          </button>
        </div>

        <div className="file-picker-content">
          {loading && <div className="file-picker-loading">Loading...</div>}
          {error && <div className="file-picker-error">{error}</div>}
          {!loading && !error && (
            <div className="file-tree">
              {entries.map((entry, index) => (
                <div
                  key={entry.path}
                  className={`file-tree-item ${index === selectedIndex ? 'selected' : ''} ${entry.is_dir ? 'is-dir' : 'is-file'}`}
                  onClick={() => {
                    setSelectedIndex(index);
                    handleEntryClick(entry);
                  }}
                  onDoubleClick={() => handleEntryDoubleClick(entry)}
                >
                  <i className={`fa ${entry.is_dir ? 'fa-folder' : 'fa-file'}`} />
                  <span className="file-tree-name">{entry.name}</span>
                  {entry.is_symlink && <span className="file-tree-symlink">→</span>}
                </div>
              ))}
              {entries.length === 0 && !loading && (
                <div className="file-picker-empty">Directory is empty</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * FilePickerButton - Toggle button for the file picker
 */
interface FilePickerButtonProps {
  onClick: () => void;
  isOpen: boolean;
}

export function FilePickerButton({ onClick, isOpen }: FilePickerButtonProps) {
  return (
    <button
      className={`file-picker-button ${isOpen ? 'active' : ''}`}
      onClick={onClick}
      title="File picker"
    >
      <i className={`fa fa-folder${isOpen ? '-open' : ''}`} />
    </button>
  );
}
