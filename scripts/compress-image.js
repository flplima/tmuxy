#!/usr/bin/env node
/**
 * Compress image for LLM token efficiency
 *
 * Usage:
 *   compress-image input.png                    # outputs to input.compressed.png
 *   compress-image input.png output.png         # outputs to output.png
 *   compress-image input.png -                  # outputs path to stdout (for piping)
 *   agent-browser screenshot | compress-image   # reads path from stdin
 *
 * Options:
 *   --width, -w    Max width (default: 800)
 *   --quality, -q  JPEG/WebP quality 1-100 (default: 70)
 *   --format, -f   Output format: jpeg, png, webp (default: jpeg)
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

async function compressImage(inputPath, outputPath, options = {}) {
  const {
    maxWidth = 800,
    quality = 70,
    format = 'jpeg'
  } = options;

  let pipeline = sharp(inputPath);

  // Get metadata to check dimensions
  const metadata = await pipeline.metadata();

  // Resize if wider than maxWidth
  if (metadata.width > maxWidth) {
    pipeline = pipeline.resize(maxWidth, null, {
      withoutEnlargement: true,
      fit: 'inside'
    });
  }

  // Apply format-specific compression
  switch (format) {
    case 'jpeg':
    case 'jpg':
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality });
      break;
    case 'png':
      pipeline = pipeline.png({ compressionLevel: 9, palette: true });
      break;
    default:
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
  }

  await pipeline.toFile(outputPath);

  // Get file sizes for stats
  const inputSize = fs.statSync(inputPath).size;
  const outputSize = fs.statSync(outputPath).size;
  const reduction = ((1 - outputSize / inputSize) * 100).toFixed(1);

  return {
    input: inputPath,
    output: outputPath,
    inputSize,
    outputSize,
    reduction: `${reduction}%`,
    dimensions: `${metadata.width}x${metadata.height} -> ${Math.min(metadata.width, maxWidth)}x${Math.round(metadata.height * Math.min(maxWidth, metadata.width) / metadata.width)}`
  };
}

async function main() {
  const args = process.argv.slice(2);

  // Parse options
  const options = {
    maxWidth: 800,
    quality: 70,
    format: 'jpeg'
  };

  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--width' || arg === '-w') {
      options.maxWidth = parseInt(args[++i], 10);
    } else if (arg === '--quality' || arg === '-q') {
      options.quality = parseInt(args[++i], 10);
    } else if (arg === '--format' || arg === '-f') {
      options.format = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: compress-image [options] <input> [output]

Options:
  -w, --width <n>    Max width in pixels (default: 800)
  -q, --quality <n>  Quality 1-100 (default: 70)
  -f, --format <fmt> Output format: jpeg, png, webp (default: jpeg)
  -h, --help         Show this help

Examples:
  compress-image screenshot.png
  compress-image screenshot.png compressed.jpg
  compress-image -w 600 -q 60 screenshot.png
  agent-browser screenshot | xargs compress-image
`);
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  // Read from stdin if no input provided
  let inputPath = positional[0];
  if (!inputPath) {
    // Check if stdin has data
    if (!process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      inputPath = Buffer.concat(chunks).toString().trim();
      // Extract path from agent-browser output if needed
      const match = inputPath.match(/([^\s]+\.(png|jpg|jpeg|webp))/i);
      if (match) {
        inputPath = match[1];
      }
    }
  }

  if (!inputPath) {
    console.error('Error: No input file provided');
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: File not found: ${inputPath}`);
    process.exit(1);
  }

  // Generate output path
  let outputPath = positional[1];
  const outputToStdout = outputPath === '-';

  if (!outputPath || outputToStdout) {
    const ext = options.format === 'jpeg' ? 'jpg' : options.format;
    const basename = path.basename(inputPath, path.extname(inputPath));
    const dir = path.dirname(inputPath);
    outputPath = path.join(dir, `${basename}.compressed.${ext}`);
  }

  try {
    const result = await compressImage(inputPath, outputPath, options);

    if (outputToStdout) {
      // Just output the path for piping
      console.log(result.output);
    } else {
      // Output stats
      console.log(`Compressed: ${result.input}`);
      console.log(`  Output: ${result.output}`);
      console.log(`  Size: ${(result.inputSize / 1024).toFixed(1)}KB -> ${(result.outputSize / 1024).toFixed(1)}KB (${result.reduction} smaller)`);
      console.log(`  Dimensions: ${result.dimensions}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
