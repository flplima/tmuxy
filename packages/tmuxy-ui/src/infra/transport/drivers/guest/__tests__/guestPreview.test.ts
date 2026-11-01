/**
 * `read_preview` on the in-browser guests: tmux names the file a pane may
 * preview and a run-shell reads it, under the server's rules. The query here
 * plays tmux.
 */
import { describe, expect, it } from 'vitest';
import { readGuestPreview } from '../guestPreview';

/** tmux, answering the preview tags with `tags` and run-shell with `files`. */
function tmux(tags: string, files: Record<string, string>) {
  const asked: string[] = [];
  const query = async (command: string) => {
    asked.push(command);
    if (command.startsWith('display-message')) return tags;
    const file = Object.keys(files).find((path) => command.includes(path));
    return file ? files[file] : '';
  };
  return { query, asked };
}

describe('readGuestPreview', () => {
  it('reads the markdown document tmux says the pane previews', async () => {
    const { query, asked } = tmux('preview\n/root/notes/a.md\n', {
      '/root/notes/a.md': '# Title\n\nhello',
    });
    await expect(readGuestPreview(query, '%3', undefined)).resolves.toEqual({
      kind: 'markdown',
      name: 'a.md',
      text: '# Title\n\nhello',
      net: false,
    });
    expect(asked[0]).toContain("display-message -p -t %3 '#{@tmuxy-pane-preview}'");
    expect(asked[1]).toBe("run-shell 'cat -- '\\''/root/notes/a.md'\\'''");
  });

  it('reads a resource beside the document, in base64', async () => {
    const { query } = tmux('preview\n/root/notes/a.md\n', {
      '/root/notes/img/x.png': 'iVBO\nRw0K\n',
    });
    await expect(readGuestPreview(query, '%3', 'img/x.png')).resolves.toEqual({
      mime: 'image/png',
      data: 'iVBORw0K',
    });
  });

  it('single-quotes shell arguments even when a path contains tabs and backticks', async () => {
    const tricky = "/root/notes/tab\t`id`$(whoami)'s.md";
    const { query, asked } = tmux(`preview\n${tricky}\n`, {
      [tricky]: 'safe',
    });
    await readGuestPreview(query, '%3', undefined);
    // Inside tmux's double-quoted run-shell argument, `/bin/sh` must still see
    // single quotes around the path so backticks and `$()` are inert.
    expect(asked[1]).toBe(
      "run-shell \"cat -- '/root/notes/tab\\011`id`\\044(whoami)'\\134''s.md'\"",
    );
  });

  it.each([
    ['a pane that is not previewing', '\n\n', undefined],
    ['a relative document path', 'preview\nnotes/a.md\n', undefined],
    ['a resource out of the document folder', 'preview\n/root/a.md\n', '../etc/passwd'],
    ['a page, which needs a server to stage it', 'preview\n/root/site/index.html\n', undefined],
  ])('refuses %s', async (_what, tags, path) => {
    const { query } = tmux(tags, {});
    await expect(readGuestPreview(query, '%3', path)).rejects.toMatchObject({ kind: 'forbidden' });
  });
});
