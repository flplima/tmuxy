import type { Scenario } from '../scenario';

/** A markdown note with a heading, a paragraph and a mermaid diagram. */
const NOTES = [
  '# Preview Title',
  '',
  'Some *text* to select.',
  '',
  '```mermaid',
  'graph TD',
  '  A[Start] --> B[Finish]',
  '```',
  '',
].join('\n');

/**
 * Two panes side by side (%1 active), and `tmuxy open notes.md` typed in %0:
 * %0 runs the preview widget, and the document it reads is recorded.
 */
const scenario: Scenario = {
  steps: [
    {
      state: 'previewing',
      files: { 'notes.md': NOTES },
      run: ['split-window -h', "send-keys -t %0 -l 'tmuxy open notes.md'", 'send-keys -t %0 Enter'],
      // The widget's first look at the file.
      waitFor: '__REV__:',
      previews: ['%0'],
    },
  ],
};
export default scenario;
