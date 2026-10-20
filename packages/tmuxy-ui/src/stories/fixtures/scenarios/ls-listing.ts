import type { Scenario } from '../scenario';

/**
 * One pane at the prompt in a home with a handful of files; then `ls` typed
 * and run; then an `echo` of glyphs a canvas measures by hand (●, ⎿, box
 * drawing) under the listing.
 */
const scenario: Scenario = {
  steps: [
    {
      state: 'prompt',
      files: Object.fromEntries(
        [
          'README.md',
          'Cargo.toml',
          'package.json',
          'notes.txt',
          'deploy.sh',
          'src/main.rs',
          'docs/guide.md',
          'build.log',
        ].map((path) => [path, `${path}\n`]),
      ),
    },
    {
      state: 'listed',
      run: ['send-keys -t %0 -l ls', 'send-keys -t %0 Enter'],
      waitFor: 'package.json',
    },
    {
      state: 'symbols',
      run: ['send-keys -t %0 -l \'echo "● ⎿ ┌─┐"\'', 'send-keys -t %0 Enter'],
      // The printed line, which starts a row; the typed one is quoted.
      waitFor: '\n● ⎿ ┌─┐',
    },
  ],
};
export default scenario;
