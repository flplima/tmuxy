#!/usr/bin/env node
/**
 * Take screenshot using Playwright CDP connection
 * Usage: screenshot-pw.js <name>
 * Output: /tmp/screenshots/<name>.compressed.jpg
 */

const { chromium } = require('playwright');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const name = process.argv[2] || 'screenshot';
const dir = '/tmp/screenshots';

async function main() {
  fs.mkdirSync(dir, { recursive: true });

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  const page = contexts[0]?.pages()[0];

  if (!page) {
    console.error('No page found');
    process.exit(1);
  }

  const pngPath = path.join(dir, `${name}.png`);
  const jpgPath = path.join(dir, `${name}.compressed.jpg`);

  // Use CDP directly for screenshot (avoids font loading timeout)
  const client = await page.context().newCDPSession(page);
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(pngPath, Buffer.from(data, 'base64'));

  // Compress with sharp
  const metadata = await sharp(pngPath).metadata();
  const maxWidth = 800;

  let pipeline = sharp(pngPath);
  if (metadata.width > maxWidth) {
    pipeline = pipeline.resize(maxWidth, null, { fit: 'inside' });
  }
  await pipeline.jpeg({ quality: 70, mozjpeg: true }).toFile(jpgPath);

  const inputSize = fs.statSync(pngPath).size;
  const outputSize = fs.statSync(jpgPath).size;
  const reduction = ((1 - outputSize / inputSize) * 100).toFixed(1);

  console.log(`Saved: ${jpgPath}`);
  console.log(`Size: ${(inputSize/1024).toFixed(1)}KB -> ${(outputSize/1024).toFixed(1)}KB (${reduction}% smaller)`);

  await browser.close();
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
