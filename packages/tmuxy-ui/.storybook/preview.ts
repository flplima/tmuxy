import type { Preview } from '@storybook/react-vite';
import '../src/styles.css';
import '../src/fonts/nerd-font.css';
import '../src/components/widgets/init';

const preview: Preview = {
  // Toolbar: show the raw tmux TUI (the v86 guest's VGA console, drawn by tmux
  // itself) next to or over the tmuxy rendering. Honoured by stories on the
  // shared v86 engine via `withTmuxView` (src/stories/tmuxView.tsx).
  globalTypes: {
    tmuxView: {
      description: 'Raw tmux TUI beside/over the tmuxy rendering (v86 stories)',
      toolbar: {
        title: 'tmux view',
        icon: 'sidebyside',
        dynamicTitle: true,
        items: [
          { value: 'off', title: 'tmux view: off' },
          { value: 'side', title: 'tmux view: side by side' },
          { value: 'overlay', title: 'tmux view: overlay' },
        ],
      },
    },
  },
  // Default the v86 (Scenarios/Application) stories to side-by-side: tmuxy on
  // the left, the raw tmux VGA console on the right.
  initialGlobals: { tmuxView: 'side' },
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'tmuxy',
      values: [
        { name: 'tmuxy', value: '#0f0f12' },
        { name: 'light', value: '#f5f5f5' },
      ],
    },
    layout: 'fullscreen',
  },
};

export default preview;
