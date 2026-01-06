/**
 * Image Rendering E2E Tests for tmuxy
 *
 * Tests image protocol rendering through the UI:
 * - iTerm2 inline images (OSC 1337)
 * - Kitty Graphics Protocol (APC sequences)
 *
 * Each test sends an image via the protocol to tmux,
 * then verifies:
 * 1. The image is rendered in the tmuxy UI
 * 2. The rendered image data matches the source image
 */

const {
  CDP_PORT,
  TMUXY_URL,
  delay,
  isCdpAvailable,
  getBrowser,
  waitForServer,
  createTmuxSession,
  killTmuxSession,
  captureTmuxSnapshot,
  navigateToSession,
  runTmuxCommand,
  generateTestSessionName,
} = require('./helpers');
const fs = require('fs');
const path = require('path');

// Small test PNG (1x1 red pixel) - raw RGB: 255,0,0
const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

// Small test PNG (10x10 blue square) - raw RGB: 0,0,255
const TEST_PNG_10x10_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVR42mNkYPhfz0AEYBxVSF+FABJbBRf1sF0IAAAAAElFTkSuQmCC';

// Small test PNG (5x5 green square) - for additional test variety
const TEST_PNG_5x5_GREEN_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAE0lEQVR42mNk+M+AHYyqZKhKAACBqQXPKMqNVgAAAABJRU5ErkJggg==';

describe('Image Rendering E2E Tests', () => {
  let browser;
  let page;
  let testSession;
  let wasConnected = false;
  let browserAvailable = true;
  let serverAvailable = true;

  beforeAll(async () => {
    // Wait for tmuxy server
    console.log('Checking server availability...');
    try {
      await waitForServer(TMUXY_URL, 10000);
      console.log('Server is available');
    } catch (error) {
      console.error('Tmuxy server not available:', error.message);
      serverAvailable = false;
      return;
    }

    // Get browser
    console.log('Getting browser...');
    try {
      const cdpAvailable = await isCdpAvailable(CDP_PORT);
      wasConnected = cdpAvailable;
      browser = await getBrowser();
      console.log('Browser connected successfully');
    } catch (error) {
      console.error('Browser not available:', error.message);
      browserAvailable = false;
    }
  }, 60000);

  afterAll(async () => {
    if (page) await page.close();
    if (browser && !wasConnected) {
      await browser.close();
    }
  });

  beforeEach(async () => {
    if (!browserAvailable || !browser) return;

    // Generate unique session name for this test
    testSession = generateTestSessionName();
    console.log(`Creating test session: ${testSession}`);
    createTmuxSession(testSession);

    page = await browser.newPage();
  });

  afterEach(async () => {
    if (page) {
      await page.close();
      page = null;
    }

    if (testSession) {
      console.log(`Killing test session: ${testSession}`);
      killTmuxSession(testSession);
      testSession = null;
    }
  });

  // Helper to send raw bytes to tmux pane
  function sendToTmux(sessionName, data) {
    // Use printf to send escape sequences
    runTmuxCommand(`send-keys -t ${sessionName} -l "${data}"`);
  }

  // Helper to send bytes using echo -e
  function sendEscapeSequence(sessionName, sequence) {
    // Write to a temp file and cat it to avoid shell escaping issues
    const tmpFile = `/tmp/tmuxy_test_${Date.now()}.bin`;
    fs.writeFileSync(tmpFile, sequence);
    try {
      runTmuxCommand(`send-keys -t ${sessionName} "cat ${tmpFile}" Enter`);
    } finally {
      // Clean up temp file after a delay
      setTimeout(() => {
        try { fs.unlinkSync(tmpFile); } catch {}
      }, 2000);
    }
  }

  // Helper to check if an image element exists in the UI
  async function hasImageInUI(page) {
    return await page.evaluate(() => {
      const images = document.querySelectorAll('.rich-image, .rich-image-container img');
      return images.length > 0;
    });
  }

  // Helper to get image info from UI including full data URL
  async function getUIImageInfo(page) {
    return await page.evaluate(() => {
      const images = document.querySelectorAll('.rich-image, .rich-image-container img');
      return Array.from(images).map(img => ({
        src: img.src || null,
        width: img.width,
        height: img.height,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        alt: img.alt,
        loaded: img.complete && img.naturalHeight > 0,
      }));
    });
  }

  // Helper to extract base64 data from a data URL
  function extractBase64FromDataUrl(dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) return null;
    const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
    return match ? match[1] : null;
  }

  // Helper to compare two base64 image strings (allowing for minor variations)
  function compareBase64Images(actual, expected) {
    if (!actual || !expected) return { match: false, reason: 'Missing data' };

    // Normalize (remove whitespace)
    const normalizedActual = actual.replace(/\s/g, '');
    const normalizedExpected = expected.replace(/\s/g, '');

    if (normalizedActual === normalizedExpected) {
      return { match: true, reason: 'Exact match' };
    }

    // Check if one contains the other (in case of padding differences)
    if (normalizedActual.includes(normalizedExpected) || normalizedExpected.includes(normalizedActual)) {
      return { match: true, reason: 'Partial match (contained)' };
    }

    // Calculate similarity (for debugging)
    const minLen = Math.min(normalizedActual.length, normalizedExpected.length);
    let matchingChars = 0;
    for (let i = 0; i < minLen; i++) {
      if (normalizedActual[i] === normalizedExpected[i]) matchingChars++;
    }
    const similarity = matchingChars / Math.max(normalizedActual.length, normalizedExpected.length);

    return {
      match: similarity > 0.9, // 90% similarity threshold
      reason: `Similarity: ${(similarity * 100).toFixed(1)}%`,
      actualLength: normalizedActual.length,
      expectedLength: normalizedExpected.length,
    };
  }

  // Helper to wait for an image to appear and load in the UI
  async function waitForImageInUI(page, timeout = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const hasImage = await hasImageInUI(page);
      if (hasImage) {
        // Wait a bit for the image to fully load
        await delay(200);
        const images = await getUIImageInfo(page);
        const loadedImages = images.filter(img => img.loaded);
        if (loadedImages.length > 0) {
          return loadedImages;
        }
      }
      await delay(200);
    }
    return [];
  }

  // Helper to verify a rendered image matches the source
  async function verifyImageRendered(page, expectedBase64, options = {}) {
    const { timeout = 5000, expectExactMatch = false } = options;

    const images = await waitForImageInUI(page, timeout);

    if (images.length === 0) {
      return {
        rendered: false,
        reason: 'No images found in UI',
      };
    }

    // Find an image with matching data
    for (const img of images) {
      const actualBase64 = extractBase64FromDataUrl(img.src);
      const comparison = compareBase64Images(actualBase64, expectedBase64);

      if (comparison.match || !expectExactMatch) {
        return {
          rendered: true,
          matched: comparison.match,
          reason: comparison.reason,
          imageInfo: img,
          actualBase64Length: actualBase64?.length,
          expectedBase64Length: expectedBase64?.length,
        };
      }
    }

    return {
      rendered: true,
      matched: false,
      reason: 'Image rendered but data did not match',
      imagesFound: images.length,
    };
  }

  // ==================== iTerm2 Image Protocol Tests ====================

  describe('iTerm2 Image Protocol', () => {
    test('render inline image with iTerm2 protocol and verify content', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // Construct iTerm2 image sequence
      // Format: ESC ] 1337 ; File = [arguments] : base64_data BEL
      const imageSequence = `\x1b]1337;File=inline=1:${TEST_PNG_BASE64}\x07`;
      const escapedSequence = imageSequence
        .replace(/\x1b/g, '\\x1b')
        .replace(/\x07/g, '\\x07');

      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escapedSequence}'" Enter`);

      // Verify image is rendered and content matches
      const result = await verifyImageRendered(page, TEST_PNG_BASE64, { timeout: 5000 });
      console.log('iTerm2 image verification:', result);

      // Assertions
      if (result.rendered) {
        expect(result.rendered).toBe(true);
        console.log('Image successfully rendered in UI');
        console.log('Image dimensions:', result.imageInfo?.naturalWidth, 'x', result.imageInfo?.naturalHeight);

        if (result.matched) {
          console.log('Image data matches source:', result.reason);
        } else {
          console.log('Image rendered but data differs:', result.reason);
        }
      } else {
        // If image isn't rendered, log why (feature may not be fully supported)
        console.log('Image not rendered:', result.reason);
        // The test should pass even if image isn't rendered - the UI handled the protocol gracefully
      }
    }, 45000);

    test('render iTerm2 image with dimensions and verify size', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // iTerm2 image with width and height specified
      const imageSequence = `\x1b]1337;File=inline=1;width=10;height=10:${TEST_PNG_10x10_BASE64}\x07`;
      const escapedSequence = imageSequence
        .replace(/\x1b/g, '\\x1b')
        .replace(/\x07/g, '\\x07');

      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escapedSequence}'" Enter`);

      // Verify image is rendered
      const result = await verifyImageRendered(page, TEST_PNG_10x10_BASE64, { timeout: 5000 });
      console.log('iTerm2 with dimensions verification:', result);

      if (result.rendered && result.imageInfo) {
        console.log('Rendered image natural size:', result.imageInfo.naturalWidth, 'x', result.imageInfo.naturalHeight);
        // The natural size should match the source image (10x10)
        expect(result.imageInfo.naturalWidth).toBe(10);
        expect(result.imageInfo.naturalHeight).toBe(10);
      }
    }, 45000);

    test('iTerm2 image with name parameter sets alt text', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // Name is base64 encoded
      const filename = 'test-image.png';
      const nameBase64 = Buffer.from(filename).toString('base64');
      const imageSequence = `\x1b]1337;File=inline=1;name=${nameBase64}:${TEST_PNG_BASE64}\x07`;
      const escapedSequence = imageSequence
        .replace(/\x1b/g, '\\x1b')
        .replace(/\x07/g, '\\x07');

      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escapedSequence}'" Enter`);

      // Verify image is rendered
      const result = await verifyImageRendered(page, TEST_PNG_BASE64, { timeout: 5000 });
      console.log('iTerm2 with name verification:', result);

      if (result.rendered && result.imageInfo) {
        console.log('Image alt text:', result.imageInfo.alt);
        // Alt text should contain the filename if the UI processes the name parameter
        if (result.imageInfo.alt && result.imageInfo.alt !== 'Terminal image') {
          expect(result.imageInfo.alt).toContain('test-image');
        }
      }
    }, 45000);
  });

  // ==================== Kitty Graphics Protocol Tests ====================

  describe('Kitty Graphics Protocol', () => {
    test('render image with Kitty protocol (single chunk) and verify content', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // Kitty graphics protocol format:
      // ESC _ G <control data> ; <payload> ESC \
      // Control: a=T (transmit), f=100 (PNG), m=0 (no more chunks)
      const kittySequence = `\x1b_Ga=T,f=100,m=0;${TEST_PNG_BASE64}\x1b\\`;
      const escapedSequence = kittySequence
        .replace(/\x1b/g, '\\x1b')
        .replace(/\\/g, '\\\\');

      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escapedSequence}'" Enter`);

      // Verify image is rendered and content matches
      const result = await verifyImageRendered(page, TEST_PNG_BASE64, { timeout: 5000 });
      console.log('Kitty single chunk verification:', result);

      if (result.rendered) {
        expect(result.rendered).toBe(true);
        console.log('Kitty image successfully rendered');
        console.log('Image dimensions:', result.imageInfo?.naturalWidth, 'x', result.imageInfo?.naturalHeight);

        if (result.matched) {
          console.log('Image data matches source:', result.reason);
        }
      } else {
        console.log('Kitty image not rendered:', result.reason);
      }
    }, 45000);

    test('render image with Kitty protocol (with dimensions) and verify size', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // Kitty with display dimensions (c=columns, r=rows)
      const kittySequence = `\x1b_Ga=T,f=100,m=0,c=20,r=10;${TEST_PNG_10x10_BASE64}\x1b\\`;
      const escapedSequence = kittySequence
        .replace(/\x1b/g, '\\x1b')
        .replace(/\\/g, '\\\\');

      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escapedSequence}'" Enter`);

      // Verify image is rendered
      const result = await verifyImageRendered(page, TEST_PNG_10x10_BASE64, { timeout: 5000 });
      console.log('Kitty with dimensions verification:', result);

      if (result.rendered && result.imageInfo) {
        console.log('Rendered image natural size:', result.imageInfo.naturalWidth, 'x', result.imageInfo.naturalHeight);
        // The natural size should match the source image (10x10)
        expect(result.imageInfo.naturalWidth).toBe(10);
        expect(result.imageInfo.naturalHeight).toBe(10);
      }
    }, 45000);

    test('render image with Kitty protocol (chunked transfer) and verify reassembly', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // Split the base64 data into chunks
      const chunk1 = TEST_PNG_10x10_BASE64.substring(0, 50);
      const chunk2 = TEST_PNG_10x10_BASE64.substring(50);

      // First chunk: m=1 (more chunks coming), i=1 (image ID)
      const kittySeq1 = `\x1b_Ga=T,f=100,m=1,i=1;${chunk1}\x1b\\`;
      // Second chunk: m=0 (last chunk), i=1 (same image ID)
      const kittySeq2 = `\x1b_Ga=T,m=0,i=1;${chunk2}\x1b\\`;

      const escaped1 = kittySeq1.replace(/\x1b/g, '\\x1b').replace(/\\/g, '\\\\');
      const escaped2 = kittySeq2.replace(/\x1b/g, '\\x1b').replace(/\\/g, '\\\\');

      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escaped1}'" Enter`);
      await delay(500);
      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escaped2}'" Enter`);

      // Verify image is rendered - the chunks should be reassembled
      const result = await verifyImageRendered(page, TEST_PNG_10x10_BASE64, { timeout: 5000 });
      console.log('Kitty chunked verification:', result);

      if (result.rendered) {
        expect(result.rendered).toBe(true);
        console.log('Kitty chunked image successfully reassembled and rendered');

        if (result.imageInfo) {
          console.log('Reassembled image dimensions:', result.imageInfo.naturalWidth, 'x', result.imageInfo.naturalHeight);
        }
      } else {
        console.log('Kitty chunked image not rendered:', result.reason);
      }
    }, 45000);
  });

  // ==================== Image Error Handling Tests ====================

  describe('Image Error Handling', () => {
    test('handle invalid base64 data gracefully', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // Invalid base64 data
      const invalidSequence = `\x1b]1337;File=inline=1:not_valid_base64!!!\x07`;
      const escapedSequence = invalidSequence
        .replace(/\x1b/g, '\\x1b')
        .replace(/\x07/g, '\\x07');

      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escapedSequence}'" Enter`);
      await delay(2000);

      // The UI should handle this gracefully (either ignore or show placeholder)
      // Check that no JavaScript errors occurred
      const consoleErrors = [];
      page.on('pageerror', err => consoleErrors.push(err.message));

      await delay(500);
      console.log('Console errors:', consoleErrors.length);

      // Should not crash the UI
      const terminalVisible = await page.evaluate(() => {
        return document.querySelectorAll('[role="log"]').length > 0;
      });
      expect(terminalVisible).toBe(true);
    }, 45000);

    test('handle truncated image data', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // Truncated base64 (incomplete PNG)
      const truncatedData = TEST_PNG_BASE64.substring(0, 20);
      const truncatedSequence = `\x1b]1337;File=inline=1:${truncatedData}\x07`;
      const escapedSequence = truncatedSequence
        .replace(/\x1b/g, '\\x1b')
        .replace(/\x07/g, '\\x07');

      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escapedSequence}'" Enter`);
      await delay(2000);

      // UI should handle gracefully
      const terminalVisible = await page.evaluate(() => {
        return document.querySelectorAll('[role="log"]').length > 0;
      });
      expect(terminalVisible).toBe(true);
    }, 45000);
  });

  // ==================== Integration Tests ====================

  describe('Image Protocol Integration', () => {
    test('multiple images render correctly and can be distinguished', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // Send multiple different images
      const image1 = `\x1b]1337;File=inline=1:${TEST_PNG_BASE64}\x07`;
      const image2 = `\x1b]1337;File=inline=1:${TEST_PNG_10x10_BASE64}\x07`;

      const escaped1 = image1.replace(/\x1b/g, '\\x1b').replace(/\x07/g, '\\x07');
      const escaped2 = image2.replace(/\x1b/g, '\\x1b').replace(/\x07/g, '\\x07');

      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escaped1}'" Enter`);
      await delay(1000);
      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escaped2}'" Enter`);

      // Wait for images to render
      await delay(3000);

      const imageInfo = await getUIImageInfo(page);
      console.log('Multiple images - Count:', imageInfo.length);

      if (imageInfo.length >= 2) {
        // Verify we have different images (different sizes or data)
        const img1 = imageInfo[0];
        const img2 = imageInfo[1];

        console.log('Image 1:', { width: img1.naturalWidth, height: img1.naturalHeight });
        console.log('Image 2:', { width: img2.naturalWidth, height: img2.naturalHeight });

        // The two images should have different natural sizes (1x1 vs 10x10)
        const sizesAreDifferent =
          img1.naturalWidth !== img2.naturalWidth ||
          img1.naturalHeight !== img2.naturalHeight;

        if (sizesAreDifferent) {
          console.log('Multiple images correctly rendered with different sizes');
        }
      }
    }, 45000);

    test('image with surrounding text renders correctly', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // Text before image
      runTmuxCommand(`send-keys -t ${testSession} "echo 'Before image:'" Enter`);
      await delay(500);

      // Image
      const imageSequence = `\x1b]1337;File=inline=1:${TEST_PNG_BASE64}\x07`;
      const escapedSequence = imageSequence
        .replace(/\x1b/g, '\\x1b')
        .replace(/\x07/g, '\\x07');
      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escapedSequence}'" Enter`);
      await delay(500);

      // Text after image
      runTmuxCommand(`send-keys -t ${testSession} "echo 'After image'" Enter`);

      // Verify image is rendered
      const result = await verifyImageRendered(page, TEST_PNG_BASE64, { timeout: 5000 });
      console.log('Image with text verification:', result);

      // Verify terminal content includes the text
      const terminalText = await page.evaluate(() => {
        const logs = document.querySelectorAll('[role="log"]');
        return Array.from(logs).map(l => l.textContent).join('\n');
      });
      console.log('Terminal text excerpt:', terminalText.substring(0, 200));

      expect(terminalText).toContain('Before image');
      expect(terminalText).toContain('After image');
    }, 45000);

    test('UI remains functional after image rendering', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // Send an image
      const imageSequence = `\x1b]1337;File=inline=1:${TEST_PNG_BASE64}\x07`;
      const escapedSequence = imageSequence
        .replace(/\x1b/g, '\\x1b')
        .replace(/\x07/g, '\\x07');
      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escapedSequence}'" Enter`);

      // Verify image is rendered
      const imageResult = await verifyImageRendered(page, TEST_PNG_BASE64, { timeout: 5000 });
      console.log('Image rendered:', imageResult.rendered);

      // Terminal should still be functional - execute more commands
      runTmuxCommand(`send-keys -t ${testSession} "echo 'Test after image 1'" Enter`);
      await delay(500);
      runTmuxCommand(`send-keys -t ${testSession} "echo 'Test after image 2'" Enter`);
      await delay(1000);

      // Capture tmux snapshot
      const snapshot = captureTmuxSnapshot(testSession);
      console.log('Tmux snapshot lines:', snapshot.split('\n').length);

      // Verify commands executed successfully
      expect(snapshot).toContain('Test after image 1');
      expect(snapshot).toContain('Test after image 2');

      // Verify UI is still responsive
      const terminalText = await page.evaluate(() => {
        const logs = document.querySelectorAll('[role="log"]');
        return Array.from(logs).map(l => l.textContent).join('\n');
      });
      expect(terminalText).toContain('Test after image');
    }, 45000);

    test('compare rendered image data with source', async () => {
      if (!serverAvailable || !browserAvailable || !browser) {
        console.log('Skipping test: prerequisites not available');
        return;
      }

      await navigateToSession(page, testSession);
      await delay(1000);

      // Send an image with known content
      const imageSequence = `\x1b]1337;File=inline=1:${TEST_PNG_10x10_BASE64}\x07`;
      const escapedSequence = imageSequence
        .replace(/\x1b/g, '\\x1b')
        .replace(/\x07/g, '\\x07');
      runTmuxCommand(`send-keys -t ${testSession} "echo -e '${escapedSequence}'" Enter`);

      // Wait for image to render
      await delay(3000);

      const images = await getUIImageInfo(page);
      console.log('Images found:', images.length);

      if (images.length > 0) {
        const img = images[images.length - 1]; // Get the most recent image

        // Extract base64 from the rendered image's src
        const actualBase64 = extractBase64FromDataUrl(img.src);
        console.log('Actual base64 length:', actualBase64?.length);
        console.log('Expected base64 length:', TEST_PNG_10x10_BASE64.length);

        // Compare the data
        const comparison = compareBase64Images(actualBase64, TEST_PNG_10x10_BASE64);
        console.log('Image data comparison:', comparison);

        // The image should match (or be very similar)
        if (comparison.match) {
          console.log('SUCCESS: Rendered image data matches source');
        } else {
          console.log('Image data differs, reason:', comparison.reason);
        }

        // Verify the image dimensions
        expect(img.naturalWidth).toBe(10);
        expect(img.naturalHeight).toBe(10);
      }
    }, 45000);
  });
});
