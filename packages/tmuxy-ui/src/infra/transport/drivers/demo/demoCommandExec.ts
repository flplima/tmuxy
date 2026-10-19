import type { DemoTmux } from './DemoTmux';
import type { CreateFloatOptions } from './demoLayout';

/** Execute a tmux command without emitting state (used for batched init) */
export function executeDemoCommand(
  tmux: DemoTmux,
  command: string,
  emitState: () => void,
  handleSendKeys: (args: string[]) => void,
): void {
  if (!command) return;

  // Special handling for write-widget (content may contain special chars)
  const widgetMatch = command.match(/^write-widget\s+(%\d+)\s+(\S+)(?:\s+([\s\S]*))?$/);
  if (widgetMatch) {
    const [, paneId, widgetName, content] = widgetMatch;
    const contentLines = content ? content.split('\n') : [];
    tmux.writeWidget(paneId, widgetName, contentLines);
    return;
  }

  // The sidebar columns arrive as ONE compound command list
  // (`split-window ; break-pane ; set-option @tmuxy-window-type sidebar-*`),
  // which this engine doesn't split on `\;` — and the tag is the whole point,
  // since it is what makes the window a column rather than a tab. Recognise
  // the list by its tag and build the column directly.
  const sidebarTag = command.match(/@tmuxy-window-type\s+sidebar-(left|right)/);
  if (sidebarTag) {
    const widget = command.match(/tmuxy\s+widget\s+(\w+)/);
    tmux.createSidebar(sidebarTag[1] as 'left' | 'right', widget?.[1]);
    return;
  }

  // Answering a `tmuxy pane send -t` arrives as ONE compound list (clear the question,
  // then record the answer), which this engine doesn't split on `\;`.
  // Clearing the question is the half that shows: the answer option exists
  // for the waiting CLI, and the demo has no such process.
  const askAnswered = command.match(/set-option\s+-pu\s+-t\s+(%\d+)\s+@tmuxy-ask(?:\s|\\|$)/);
  if (askAnswered) {
    tmux.setPaneAsk(askAnswered[1], '');
    return;
  }

  // A sidebar column being dragged to a new width, or reset to its default.
  const sidebarWidth = command.match(/set-option\s+-w\s+-t\s+(@\d+)\s+@tmuxy-sidebar-cols\s+(\d+)/);
  if (sidebarWidth) {
    tmux.setSidebarCols(sidebarWidth[1], Number(sidebarWidth[2]));
    return;
  }
  const sidebarWidthReset = command.match(
    /set-option\s+-u\s+-w\s+-t\s+(@\d+)\s+@tmuxy-sidebar-cols/,
  );
  if (sidebarWidthReset) {
    tmux.setSidebarCols(sidebarWidthReset[1], null);
    return;
  }

  // A sidebar column being closed (hidden, pane kept) or shown again.
  const sidebarHide = command.match(/set-option\s+-w\s+-t\s+(@\d+)\s+@tmuxy-sidebar-hidden\s+1/);
  if (sidebarHide) {
    tmux.setSidebarHidden(sidebarHide[1], true);
    return;
  }
  const sidebarShow = command.match(/set-option\s+-u\s+-w\s+-t\s+(@\d+)\s+@tmuxy-sidebar-hidden/);
  if (sidebarShow) {
    tmux.setSidebarHidden(sidebarShow[1], false);
    return;
  }

  // A paste: the text staged in a buffer as a double-quoted string of octal
  // byte escapes (`tmuxDoubleQuoted`), which the generic parser below would
  // mangle, then pasted. The demo's shell has no bracketed-paste mode, so the
  // paste arrives the way tmux delivers one to such a pane: the text, with
  // each newline a Return. Nor does it synchronize panes, so of the paste's
  // `if-shell` on `pane_synchronized` it is the plain `paste-buffer` that runs.
  const setBuffer = command.match(/^set-buffer\s+(-a\s+)?-b\s+(\S+)\s+"(.*)"$/);
  if (setBuffer) {
    tmux.buffers.set(setBuffer[2], decodeDoubleQuoted(setBuffer[3]), setBuffer[1] !== undefined);
    return;
  }
  const pasteBuffer = command.match(/'paste-buffer\s+-p\s+-d\s+-b\s+(\S+)\s+-t\s+([^\s']+)'$/);
  if (pasteBuffer) {
    const [, buffer, target] = pasteBuffer;
    (tmux.buffers.read(buffer, true) ?? '').split('\n').forEach((line, i) => {
      if (i > 0) handleSendKeys(['-t', target, 'Enter']);
      if (line) handleSendKeys(['-t', target, '-l', '--', line]);
    });
    return;
  }

  // Parse tmux command
  const parts = parseTmuxCommand(command);
  if (parts.length === 0) return;

  const cmd = parts[0];

  switch (cmd) {
    case 'send-keys': {
      handleSendKeys(parts.slice(1));
      break;
    }

    case 'split-window':
    case 'splitw': {
      const isVertical = parts.includes('-h');
      const newPaneId = tmux.splitPane(isVertical ? 'vertical' : 'horizontal');
      // A split can carry a command to run in the new pane. The one the app
      // itself issues is `tmuxy widget <name>` (the tree column), so honour
      // that form: without it the left sidebar's pane would come up as a bare
      // shell here and never render its widget.
      const widget = command.match(/tmuxy\s+widget\s+(\w+)/);
      if (newPaneId && widget) tmux.writeWidget(newPaneId, widget[1], []);
      break;
    }

    // The pane-scoped tmuxy options a process writes about its own pane:
    // `@tmuxy-pane-state` (what it is doing — `tmuxy pane state`) and
    // `@tmuxy-ask` (a send waiting on the user — `tmuxy pane send -t`). Only these
    // two are honoured; the demo has no general option store.
    //
    // `-u` unsets, which is how a question is answered and how a process
    // stops declaring a state.
    case 'set-option':
    case 'set': {
      const scoped = parts.some((p) => /^-[a-zA-Z]*p/.test(p));
      if (!scoped) break;
      const unset = parts.some((p) => /^-[a-zA-Z]*u/.test(p));
      const optIdx = parts.findIndex(
        (p) => p === '@tmuxy-pane-state' || p === '@tmuxy-ask' || p === '@tmuxy-ask-answer',
      );
      if (optIdx === -1) break;
      const tIdx = parts.indexOf('-t');
      const target =
        tIdx !== -1 && tIdx + 1 < parts.length ? parts[tIdx + 1] : tmux.getState().active_pane_id;
      if (!target) break;
      // The CLI single-quotes the value through shquote; a story sending the
      // command by hand does not.
      const value = unset ? '' : (parts[optIdx + 1] ?? '').replace(/^'(.*)'$/, '$1');
      if (parts[optIdx] === '@tmuxy-pane-state') tmux.setPaneState(target, value);
      else if (parts[optIdx] === '@tmuxy-ask') tmux.setPaneAsk(target, value);
      // `@tmuxy-ask-answer` is written for the waiting `tmuxy pane send` process to
      // read; there is no such process in the demo, so recording it would
      // only be state nothing consumes.
      break;
    }

    case 'new-window':
    case 'neww': {
      tmux.newWindow();
      break;
    }

    // Tab Overview drag-reorder: `move-window -b/-a -s <src> -t <target>`.
    case 'move-window':
    case 'movew': {
      const sIdx = parts.indexOf('-s');
      const tIdx = parts.indexOf('-t');
      if (sIdx !== -1 && tIdx !== -1) {
        tmux.moveWindow(parts[sIdx + 1], parts[tIdx + 1], parts.includes('-a'));
      }
      break;
    }

    case 'select-window':
    case 'selectw': {
      const tIdx = parts.indexOf('-t');
      if (tIdx !== -1 && tIdx + 1 < parts.length) {
        const target = parts[tIdx + 1];
        // Parse ":=N" format
        const match = target.match(/:=?(\d+)$/);
        if (match) {
          tmux.selectWindow(match[1]);
        } else {
          tmux.selectWindow(target);
        }
      }
      break;
    }

    case 'next-window':
    case 'next':
      tmux.nextWindow();
      break;

    case 'previous-window':
    case 'prev':
      tmux.previousWindow();
      break;

    case 'select-pane':
    case 'selectp': {
      // The marked pane: `-m` marks the target (or the active pane), `-M`
      // clears the mark. Neither changes which pane is active.
      if (parts.includes('-M')) {
        tmux.markPane(null);
        break;
      }
      if (parts.includes('-m')) {
        const mIdx = parts.indexOf('-t');
        const target =
          mIdx !== -1 && mIdx + 1 < parts.length ? parts[mIdx + 1] : tmux.getState().active_pane_id;
        if (target) tmux.markPane(target);
        break;
      }
      // `-T <title>` names the pane; it does not select anything.
      const titleIdx = parts.indexOf('-T');
      if (titleIdx !== -1 && titleIdx + 1 < parts.length) {
        const at = parts.indexOf('-t');
        const target =
          at !== -1 && at + 1 < parts.length ? parts[at + 1] : tmux.getState().active_pane_id;
        if (target) tmux.setPaneTitle(target, parts[titleIdx + 1]);
        break;
      }
      const tIdx = parts.indexOf('-t');
      if (tIdx !== -1 && tIdx + 1 < parts.length) {
        const target = parts[tIdx + 1];
        if (target === ':.+') {
          // Next pane - select first pane that isn't active
          const state = tmux.getState();
          const panes = state.panes.filter((p) => p.window_id === state.active_window_id);
          const currentIdx = panes.findIndex((p) => p.tmux_id === state.active_pane_id);
          if (panes.length > 1) {
            const nextIdx = (currentIdx + 1) % panes.length;
            tmux.selectPane(panes[nextIdx].tmux_id);
          }
        } else {
          tmux.selectPane(target);
        }
      }
      // Direction flags
      if (parts.includes('-U')) tmux.selectPaneByDirection('Up');
      if (parts.includes('-D')) tmux.selectPaneByDirection('Down');
      if (parts.includes('-L')) tmux.selectPaneByDirection('Left');
      if (parts.includes('-R')) tmux.selectPaneByDirection('Right');
      break;
    }

    case 'kill-pane':
    case 'killp': {
      const tIdx = parts.indexOf('-t');
      if (tIdx !== -1 && tIdx + 1 < parts.length) {
        tmux.killPane(parts[tIdx + 1]);
      } else {
        tmux.killPane();
      }
      break;
    }

    case 'kill-window':
    case 'killw': {
      const tIdx = parts.indexOf('-t');
      if (tIdx !== -1 && tIdx + 1 < parts.length) {
        tmux.killWindow(parts[tIdx + 1]);
      } else {
        tmux.killWindow();
      }
      break;
    }

    case 'resize-pane':
    case 'resizep': {
      const state = tmux.getState();
      const tIdx = parts.indexOf('-t');
      const paneId =
        tIdx !== -1 && tIdx + 1 < parts.length ? parts[tIdx + 1] : (state.active_pane_id ?? '');
      const adjustment = parseInt(parts[parts.length - 1]) || 1;
      if (parts.includes('-Z')) {
        tmux.toggleZoom(tIdx !== -1 ? paneId : undefined);
      } else if (parts.includes('-U')) {
        tmux.resizePane(paneId, 'Up', adjustment);
      } else if (parts.includes('-D')) {
        tmux.resizePane(paneId, 'Down', adjustment);
      } else if (parts.includes('-L')) {
        tmux.resizePane(paneId, 'Left', adjustment);
      } else if (parts.includes('-R')) {
        tmux.resizePane(paneId, 'Right', adjustment);
      }
      break;
    }

    case 'rename-window':
    case 'renamew': {
      // rename-window -- 'name' OR rename-window name
      let name = '';
      const dashIdx = parts.indexOf('--');
      if (dashIdx !== -1 && dashIdx + 1 < parts.length) {
        name = parts[dashIdx + 1].replace(/^'|'$/g, '');
      } else if (parts.length >= 2) {
        name = parts[parts.length - 1];
      }
      if (name) {
        const state = tmux.getState();
        if (state.active_window_id) {
          tmux.renameWindow(state.active_window_id, name);
        }
      }
      break;
    }

    case 'next-layout':
      tmux.nextLayout();
      break;

    case 'select-layout':
    case 'selectl': {
      const layoutName = parts[1];
      if (layoutName) tmux.selectLayout(layoutName);
      break;
    }

    case 'swap-pane':
    case 'swapp': {
      let src = '';
      let dst = '';
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === '-s' && i + 1 < parts.length) {
          src = parts[++i];
        } else if (parts[i] === '-t' && i + 1 < parts.length) {
          dst = parts[++i];
        } else if (parts[i] === '-U') {
          // swap up - swap with previous pane
          const state = tmux.getState();
          const panes = state.panes.filter((p) => p.window_id === state.active_window_id);
          const idx = panes.findIndex((p) => p.tmux_id === state.active_pane_id);
          if (idx > 0) tmux.swapPanes(panes[idx].tmux_id, panes[idx - 1].tmux_id);
        } else if (parts[i] === '-D') {
          const state = tmux.getState();
          const panes = state.panes.filter((p) => p.window_id === state.active_window_id);
          const idx = panes.findIndex((p) => p.tmux_id === state.active_pane_id);
          if (idx >= 0 && idx < panes.length - 1)
            tmux.swapPanes(panes[idx].tmux_id, panes[idx + 1].tmux_id);
        }
      }
      if (src && dst) tmux.swapPanes(src, dst);
      break;
    }

    case 'break-pane':
    case 'breakp': {
      // `-s <pane>` names the pane to break out; without it, the active one.
      let src = '';
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === '-s' && i + 1 < parts.length) src = parts[++i];
      }
      tmux.breakPane(src || undefined);
      break;
    }

    case 'join-pane':
    case 'joinp':
    case 'move-pane':
    case 'movep': {
      // join-pane -s <pane> -t <window>: move a pane into another tab.
      let src = '';
      let dst = '';
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === '-s' && i + 1 < parts.length) src = parts[++i];
        else if (parts[i] === '-t' && i + 1 < parts.length) dst = parts[++i];
      }
      if (src && dst) tmux.joinPane(src, dst);
      break;
    }

    case 'tmuxy-image-attach': {
      // Storybook/test helper. Real images flow through the Rust image
      // parser; this is a shortcut for demo scenarios.
      // Usage: tmuxy-image-attach <paneId> <protocol> <id> <colsxrows>
      //        [<row>,<col>]
      const paneId = parts[1];
      const protocol = parts[2] as 'iterm2' | 'kitty' | 'sixel';
      const id = Number(parts[3]);
      const dims = (parts[4] ?? '40x20').split('x').map((n) => Number(n));
      const pos = (parts[5] ?? '0,0').split(',').map((n) => Number(n));
      if (paneId && protocol && Number.isFinite(id)) {
        tmux.attachImage(paneId, {
          id,
          row: pos[0] ?? 0,
          col: pos[1] ?? 0,
          width_cells: dims[0] ?? 40,
          height_cells: dims[1] ?? 20,
          protocol,
        });
      }
      break;
    }

    case 'tmuxy-float-create': {
      // Mirror bin/tmuxy/float-create option parsing.
      // Usage: tmuxy-float-create [--left|--right|--top|--bottom]
      //                           [--width N] [--height N]
      //                           [--bg dim|blur|none]
      //                           [--hide-header]
      const opts: CreateFloatOptions = {};
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        if (p === '--left') opts.drawer = 'left';
        else if (p === '--right') opts.drawer = 'right';
        else if (p === '--top') opts.drawer = 'top';
        else if (p === '--bottom') opts.drawer = 'bottom';
        else if (p === '--hide-header') opts.hideHeader = true;
        else if (p === '--width' && i + 1 < parts.length) {
          opts.width = Number(parts[++i]);
        } else if (p === '--height' && i + 1 < parts.length) {
          opts.height = Number(parts[++i]);
        } else if (p === '--bg' && i + 1 < parts.length) {
          const v = parts[++i];
          if (v === 'dim' || v === 'blur' || v === 'none') opts.bg = v;
        }
      }
      tmux.createFloat(opts);
      break;
    }

    case 'tmuxy-pane-group-add':
      tmux.groupAdd();
      break;

    case 'tmuxy-pane-group-next':
      tmux.groupNext();
      break;

    case 'tmuxy-pane-group-prev':
      tmux.groupPrev();
      break;

    case 'tmuxy-nav': {
      const dir = parts[1];
      if (dir === 'left' || dir === 'right') {
        tmux.navHorizontal(dir);
      } else if (dir === 'up' || dir === 'down') {
        tmux.navVertical(dir);
      }
      break;
    }

    case 'run-shell': {
      // Handle pane-group scripts; ignore everything else
      const cmdStr = parts.join(' ');
      if (cmdStr.includes('pane-group-add')) {
        tmux.groupAdd();
      } else if (cmdStr.includes('pane-group-switch')) {
        const paneMatch = cmdStr.match(/%\d+/);
        if (paneMatch) tmux.groupSwitch(paneMatch[0]);
      } else if (cmdStr.includes('pane-group-close')) {
        const paneMatch = cmdStr.match(/%\d+/);
        const targetId = paneMatch ? paneMatch[0] : undefined;
        // groupClose handles grouped panes; falls back to killPane for ungrouped
        if (!tmux.groupClose(targetId)) {
          tmux.killPane(targetId);
        }
      }
      break;
    }

    case 'copy-mode': {
      // Enter copy mode on the target pane (or active pane)
      let copyTarget: string | null = null;
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === '-t' && i + 1 < parts.length) {
          const t = parts[i + 1];
          if (t.startsWith('%')) copyTarget = t;
        }
      }
      const paneId = copyTarget ?? (tmux.getState() as { active_pane_id: string }).active_pane_id;
      if (paneId) {
        tmux.enterCopyMode(paneId);
        emitState();
      }
      break;
    }

    case 'resize-window':
      // Not supported in demo mode - silently ignore
      break;

    default:
      break;
  }
}

/** The body of a double-quoted tmux string: `\ooo` byte escapes, `\x` for x. */
export function decodeDoubleQuoted(body: string): string {
  const bytes: number[] = [];
  const utf8 = new TextEncoder();
  const chars = Array.from(body);
  for (let i = 0; i < chars.length; i++) {
    const octal = chars[i] === '\\' ? /^[0-7]{3}/.exec(chars.slice(i + 1, i + 4).join('')) : null;
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      if (chars[i] === '\\') i++;
      bytes.push(...utf8.encode(chars[i] ?? ''));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function parseTmuxCommand(command: string): string[] {
  // Simple command parser that handles quoted strings
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      // Check for \' escape sequence
      if (i + 1 < command.length && command[i + 1] === "'") {
        current += "'";
        i++;
        continue;
      }
      escaped = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
    } else if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}
