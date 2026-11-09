/**
 * tmuxy/no-tmux-command-literals
 *
 * UI code builds a `TmuxOp` and dispatches it; tmux's command syntax is
 * spelled in a few files of the domain layer (AGENTS.md, "UI code never writes
 * a tmux command string"). This rule holds that line: a string or template
 * that starts with a tmux command — its full name, or a short alias no word of
 * English shares — is an error outside the files the config allows.
 *
 * The allowed files are today's, named one by one: a new file that spells a
 * command fails, and moving a file's commands to their home shrinks the list.
 * Comments, tests and stories are free to say anything.
 */

const COMMANDS = [
  'attach-session',
  'bind-key',
  'break-pane',
  'capture-pane',
  'choose-tree',
  'clear-history',
  'command-prompt',
  'copy-mode',
  'detach-client',
  'display-message',
  'display-menu',
  'display-popup',
  'has-session',
  'if-shell',
  'join-pane',
  'kill-pane',
  'kill-server',
  'kill-session',
  'kill-window',
  'last-pane',
  'last-window',
  'link-window',
  'list-buffers',
  'list-keys',
  'list-panes',
  'list-sessions',
  'list-windows',
  'load-buffer',
  'move-pane',
  'move-window',
  'new-session',
  'new-window',
  'next-layout',
  'next-window',
  'paste-buffer',
  'pipe-pane',
  'previous-window',
  'refresh-client',
  'rename-session',
  'rename-window',
  'resize-pane',
  'resize-window',
  'respawn-pane',
  'rotate-window',
  'run-shell',
  'save-buffer',
  'select-layout',
  'select-pane',
  'select-window',
  'send-keys',
  'set-buffer',
  'set-environment',
  'set-option',
  'set-window-option',
  'show-options',
  'show-environment',
  'source-file',
  'split-window',
  'swap-pane',
  'swap-window',
  'switch-client',
  'unbind-key',
  'unlink-window',
  'wait-for',
  // Aliases no English word shares (`run`, `set`, `show` and `new` do).
  'breakp',
  'capturep',
  'clearhist',
  'joinp',
  'killp',
  'killw',
  'lastp',
  'linkw',
  'lsk',
  'lsp',
  'lsw',
  'movep',
  'movew',
  'neww',
  'nextl',
  'pasteb',
  'pipep',
  'renamew',
  'resizep',
  'resizew',
  'respawnp',
  'rotatew',
  'selectl',
  'selectp',
  'selectw',
  'setw',
  'showenv',
  'splitw',
  'swapp',
  'swapw',
  'switchc',
  'unlinkw',
];

const STARTS_WITH_COMMAND = new RegExp(`^\\s*(${COMMANDS.join('|')})(\\s|;|$)`);

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Spell tmux commands only where the config allows: elsewhere, build a TmuxOp and dispatch it',
    },
    schema: [
      {
        type: 'object',
        properties: { allow: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      literal:
        "'{{command}}' is tmux command syntax: build a TmuxOp (domain/commands.ts) and dispatch it instead of writing the command here.",
    },
  },
  create(context) {
    const filename = (context.filename ?? '').replaceAll('\\', '/');
    if (!filename.includes('/src/')) return {};
    if (/(__tests__|\.test\.|\.stories\.|\/stories\/|\/test\/)/.test(filename)) return {};
    const allow = context.options[0]?.allow ?? [];
    // An entry ending in `/` allows a directory; any other, one file.
    const allowed = (entry) =>
      entry.endsWith('/') ? filename.includes(`/src/${entry}`) : filename.endsWith(`/src/${entry}`);
    if (allow.some(allowed)) return {};

    const check = (node, text) => {
      const match = STARTS_WITH_COMMAND.exec(text);
      if (match) context.report({ node, messageId: 'literal', data: { command: match[1] } });
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateLiteral(node) {
        check(node, node.quasis[0]?.value.cooked ?? '');
      },
    };
  },
};
