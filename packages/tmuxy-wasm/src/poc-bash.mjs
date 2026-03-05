/**
 * bash.wasm POC – Node.js environment notes
 *
 * Status: BLOCKED on Node.js 22.22 SharedArrayBuffer deadlock
 *
 * Node.js 22.21+ has a known deadlock bug (nodejs/node#60584) where WASM
 * modules using SharedArrayBuffer via worker_threads never resolve Promises.
 * This affects @wasmer/sdk v0.10.0's instance.wait() call.
 *
 * Workarounds:
 * - Use Node.js < 22.21 or >= 24  (24 confirmed working per issue comments)
 * - Use the browser-based POC instead (poc-browser.html + poc-browser-server.mjs)
 *
 * The browser POC (10/10 tests passing) confirms all key capabilities:
 * - Interactive bash sessions via stdin WritableStream / stdout ReadableStream
 * - No instance.wait() needed – just pipeTo() for continuous streaming
 * - echo, cat, sort, head, tail, wc, find all available in sharrattj/bash
 * - File I/O, pipelines (subshell), exit codes, interactive read all work
 * - Session startup time ~1s (need to wait before sending first command)
 *
 * See: poc-browser.html for the working interactive-pattern test suite.
 * See: poc-browser-server.mjs to serve it with required COOP/COEP headers.
 */

console.log("Node.js 22.22 deadlock bug prevents @wasmer/sdk from working.");
console.log("Use the browser POC: node src/poc-browser-server.mjs");
console.log("Then open http://localhost:9100 in a browser.");
console.log("See src/poc-bash.mjs comments for details.");
