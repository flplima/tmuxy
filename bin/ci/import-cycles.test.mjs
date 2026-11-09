import { describe, expect, it } from 'vitest';
import { cycles, importGraph } from './import-cycles.mjs';

const graphOf = (files) => importGraph(Object.keys(files), (f) => files[f]);

describe('import cycles', () => {
  it('finds a loop through value and type imports, and a re-export', () => {
    const files = {
      '/s/a.ts': "import { b } from './b';",
      '/s/b.ts': "import type { C } from './dir/c';",
      '/s/dir/c.tsx': "export { a } from '../a';",
      '/s/d.ts': "import { a } from './a';",
    };
    expect(cycles(graphOf(files))).toEqual([['/s/a.ts', '/s/b.ts', '/s/dir/c.tsx']]);
  });

  it('sees no loop in a chain, an import of a package, or a module importing itself', () => {
    const files = {
      '/s/a.ts': "import { b } from './b';\nimport React from 'react';",
      '/s/b.ts': "import './c';",
      '/s/c.ts': "import { x } from './c';",
    };
    expect(cycles(graphOf(files))).toEqual([]);
  });

  it('reports two separate loops apart', () => {
    const files = {
      '/s/a.ts': "import './b';",
      '/s/b.ts': "import './a';",
      '/s/c.ts': "import './d';",
      '/s/d.ts': "import './c';",
    };
    expect(cycles(graphOf(files))).toHaveLength(2);
  });
});
