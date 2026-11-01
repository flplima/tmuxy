/**
 * Where CheerpX's runtime comes from and what its two ES modules must hash to.
 * Kept free of browser APIs so a page's server-rendered `<head>` can import it
 * and pin the modules with an import map before any script runs.
 *
 * CheerpX comes from Leaning Technologies' CDN (its license allows the CDN
 * build for open-source use). `cx.esm.js` statically imports `cx_esm.js`; the
 * files `cx_esm.js` loads after that (`cheerpOS.js` as a classic script, the
 * core and clock as workers, their WebAssembly) are not ES module imports, so
 * an import map cannot pin them.
 */
export const CX_URL = 'https://cxrtnc.leaningtech.com/1.4.0/cx.esm.js';
const CX_CORE_URL = 'https://cxrtnc.leaningtech.com/1.4.0/cx_esm.js';

/** Subresource Integrity metadata for each module, keyed by its URL. */
export const CX_INTEGRITY: Readonly<Record<string, string>> = {
  [CX_URL]: 'sha384-dKvqHbgtN6XNaGhOT8P3axuXaMwwhtNWrBnl8qI2XpLaRTO/Iw95KuB1jte6sRb0',
  [CX_CORE_URL]: 'sha384-vHHyjGM1DAL7dF+6rby1jhwpFAVcitQrB0YaoX049KEmf0mNg5RSsl+Z/BgHwjGo',
};

/**
 * The body of a `<script type="importmap">` that makes the browser refuse
 * either module unless its bytes match: it checks the bytes it executes, on
 * the static import inside `cx.esm.js` as well as on the page's own `import()`.
 * The map must be in the document before the first module loads.
 */
export const CX_IMPORT_MAP = JSON.stringify({ integrity: CX_INTEGRITY });
