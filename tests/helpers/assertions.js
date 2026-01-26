/**
 * Assertion Helpers
 *
 * Comparison and verification utilities for testing
 */

/**
 * Verify pane layout changed (positions differ)
 */
function verifyLayoutChanged(beforePanes, afterPanes) {
  if (beforePanes.length !== afterPanes.length) return true;

  return beforePanes.some((p, i) => {
    const newPane = afterPanes[i];
    return p.x !== newPane.x || p.y !== newPane.y ||
           p.width !== newPane.width || p.height !== newPane.height;
  });
}

module.exports = {
  verifyLayoutChanged,
};
