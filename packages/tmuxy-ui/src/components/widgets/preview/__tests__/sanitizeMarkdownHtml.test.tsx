import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MarkdownPreview } from '../MarkdownPreview';
import type { PreviewSource } from '../previewSource';
import type { PreviewTheme } from '../previewTheme';

vi.mock('../../../../machines/appHooks', () => ({
  useBindingOwnsKey: () => () => false,
}));

const stubSource: PreviewSource = {
  readDocument: () => Promise.resolve({ name: 'doc.md', kind: 'markdown', text: '', net: false }),
  readResource: () => Promise.resolve({ mime: 'image/png', data: '' }),
  stagePage: () => Promise.resolve(''),
};

const stubTheme: PreviewTheme = {
  mode: 'dark',
  foreground: '#e5e5e5',
  background: '#111111',
  accent: '#58a6ff',
  muted: '#888888',
  surface: '#1d1d1d',
  border: '#333333',
  fontMono: 'monospace',
  fontSize: '15px',
};

function renderMarkdown(markdown: string, net = false, onInput?: (json: string) => void) {
  return render(
    <MarkdownPreview
      doc={{ name: 'doc.md', kind: 'markdown', text: markdown, net }}
      theme={stubTheme}
      source={stubSource}
      active={true}
      onInput={onInput}
    />,
  );
}

describe('MarkdownPreview HTML tags and interactive inputs', () => {
  it('renders common safe HTML tags alongside GFM markdown', () => {
    const markdown = [
      '# Heading',
      '',
      'Press <kbd>Ctrl</kbd>+<kbd>C</kbd> for H<sub>2</sub>O and x<sup>2</sup>.',
      '',
      '<details open><summary>More info</summary><p>Hidden body</p></details>',
      '',
      '<div align="center"><p align="right"><mark>marked</mark> <ins>added</ins> <u>underlined</u></p></div>',
      '',
      '| Key | Description |',
      '| --- | --- |',
      '| `a` | First line<br>Second line |',
      '',
      '<dl><dt>Term</dt><dd>Definition</dd></dl>',
      '',
      '<table><thead><tr><th colspan="2">Header</th></tr></thead><tbody><tr><td rowspan="2">Left</td><td>Right</td></tr></tbody></table>',
      '',
      '<ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby>',
      '',
      '<fieldset><legend>Controls</legend><meter value="0.6" min="0" max="1"></meter><progress value="4" max="10"></progress></fieldset>',
    ].join('\n');

    const { container } = renderMarkdown(markdown);

    expect(container.querySelectorAll('kbd')).toHaveLength(2);
    expect(container.querySelector('sub')?.textContent).toBe('2');
    expect(container.querySelector('sup')?.textContent).toBe('2');

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(true);
    expect(details?.querySelector('summary')?.textContent).toBe('More info');

    expect(container.querySelector('div[align="center"]')).not.toBeNull();
    expect(container.querySelector('p[align="right"]')).not.toBeNull();
    expect(container.querySelector('mark')?.textContent).toBe('marked');
    expect(container.querySelector('ins')?.textContent).toBe('added');
    expect(container.querySelector('u')?.textContent).toBe('underlined');

    expect(container.querySelector('td br')).not.toBeNull();
    expect(container.querySelector('dl dt')?.textContent).toBe('Term');
    expect(container.querySelector('dl dd')?.textContent).toBe('Definition');
    expect(container.querySelector('th[colspan]')?.getAttribute('colspan')).toBe('2');
    expect(container.querySelector('td[rowspan="2"]')?.textContent).toBe('Left');
    expect(container.querySelector('ruby rt')?.textContent).toBe('かん');
    expect(container.querySelector('fieldset legend')?.textContent).toBe('Controls');
    expect(container.querySelector('meter')?.getAttribute('value')).toBe('0.6');
    expect(container.querySelector('progress')?.getAttribute('max')).toBe('10');
  });

  it('respects --net and width/height/align on <img> and <picture><source>', () => {
    const markdown = [
      '<picture>',
      '  <source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.png">',
      '  <img src="https://example.com/light.png" alt=" diagram " width="240" height="80" align="right">',
      '</picture>',
    ].join('\n');

    const offline = renderMarkdown(markdown, false);
    expect(offline.container.querySelector('source')).toBeNull();
    expect(offline.container.querySelector('img')).toBeNull();

    const online = renderMarkdown(markdown, true);
    const source = online.container.querySelector('source');
    const img = online.container.querySelector('img');
    expect(source?.getAttribute('srcset')).toBe('https://example.com/dark.png');
    expect(img?.getAttribute('src')).toBe('https://example.com/light.png');
    expect(img?.getAttribute('width')).toBe('240');
    expect(img?.getAttribute('height')).toBe('80');
    expect(img?.getAttribute('align')).toBe('right');
  });

  it('strips scripts, styles, frames, event handlers, classes and unsafe input types while preserving fenced code blocks', () => {
    const markdown = [
      '<script>window.pwned = true;</script>',
      '<style>body { display: none; }</style>',
      '<iframe src="https://evil.example"></iframe>',
      '<object data="https://evil.example"></object>',
      '<embed src="https://evil.example">',
      '<svg onload="alert(1)"><circle r="5"/></svg>',
      '<form action="https://evil.example/steal">',
      '  <div onclick="alert(1)" style="position:fixed;inset:0" class="pane-wrapper">',
      '    <input type="text" name="safe" value="ok" onfocus="alert(2)" formaction="https://evil.example">',
      '    <input type="image" src="https://evil.example/beacon.png">',
      '    <input type="submit" value="Send">',
      '    <input type="file" name="secret">',
      '    <input type="hidden" name="token" value="123">',
      '  </div>',
      '</form>',
      '',
      '```html',
      '<script>notExecuted()</script>',
      '```',
    ].join('\n');

    const { container } = renderMarkdown(markdown);

    for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'form']) {
      expect(container.querySelector(tag), `${tag} should be stripped`).toBeNull();
    }
    const div = container.querySelector('.preview-markdown div');
    expect(div?.hasAttribute('onclick')).toBe(false);
    expect(div?.hasAttribute('style')).toBe(false);
    expect(div?.hasAttribute('class')).toBe(false);

    const inputs = container.querySelectorAll('input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0].getAttribute('name')).toBe('safe');
    expect(inputs[0].hasAttribute('onfocus')).toBe(false);
    expect(inputs[0].hasAttribute('formaction')).toBe(false);

    expect(container.querySelector('pre code')?.textContent).toContain(
      '<script>notExecuted()</script>',
    );
  });

  it('emits JSON lines when <input>, <select> and <textarea> values change', () => {
    const onInput = vi.fn();
    const markdown = [
      '<input type="text" name="title" value="Initial">',
      '<input type="range" name="radius" min="0" max="32" value="8">',
      '<input type="number" id="columns" value="2">',
      '<input type="color" name="accent" value="#336699">',
      '<input type="checkbox" name="rounded" value="yes">',
      '<select name="mode"><option value="compact">Compact</option><option value="cozy" selected>Cozy</option></select>',
      '<textarea name="notes">Hello</textarea>',
    ].join('\n');

    const { container } = renderMarkdown(markdown, false, onInput);

    const textInput = container.querySelector('input[name="title"]') as HTMLInputElement;
    const rangeInput = container.querySelector('input[name="radius"]') as HTMLInputElement;
    const numberInput = container.querySelector('input#columns') as HTMLInputElement;
    const colorInput = container.querySelector('input[name="accent"]') as HTMLInputElement;
    const checkboxInput = container.querySelector('input[name="rounded"]') as HTMLInputElement;
    const select = container.querySelector('select[name="mode"]') as HTMLSelectElement;
    const textarea = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;

    expect(select.value).toBe('cozy');
    expect(textarea.value).toBe('Hello');

    fireEvent.change(textInput, { target: { value: 'Updated Title' } });
    fireEvent.change(rangeInput, { target: { value: '16' } });
    fireEvent.change(numberInput, { target: { value: '4' } });
    fireEvent.change(colorInput, { target: { value: '#ff5500' } });
    fireEvent.click(checkboxInput);
    fireEvent.change(select, { target: { value: 'compact' } });
    fireEvent.change(textarea, { target: { value: 'New notes' } });

    const emitted = onInput.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(emitted).toEqual([
      { input: 'title', type: 'text', value: 'Updated Title' },
      { input: 'radius', type: 'range', value: 16 },
      { input: 'columns', type: 'number', value: 4 },
      { input: 'accent', type: 'color', value: '#ff5500' },
      { input: 'rounded', type: 'checkbox', value: true },
      { input: 'mode', type: 'select', value: 'compact' },
      { input: 'notes', type: 'textarea', value: 'New notes' },
    ]);
  });
});
