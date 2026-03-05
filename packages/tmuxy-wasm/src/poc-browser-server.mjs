/**
 * Minimal HTTP server to serve the browser POC with COOP/COEP headers.
 * Required for SharedArrayBuffer (used by @wasmer/sdk).
 *
 * Serves on port 9100.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HTML_PATH = join(__dirname, "poc-browser.html");

const server = createServer((req, res) => {
  // Required headers for SharedArrayBuffer access
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cache-Control", "no-store");

  if (req.url === "/" || req.url === "/poc-browser.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(HTML_PATH, "utf8"));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

const PORT = 9100;
server.listen(PORT, () => {
  console.log(`POC server running at http://localhost:${PORT}`);
  console.log("Open in browser (requires COOP/COEP support)");
});
