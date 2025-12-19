/**
 * Download and cache all required binaries for ClipChimp
 *
 * This script orchestrates downloading all binaries needed for the app:
 * - yt-dlp (video downloader)
 * - whisper.cpp (transcription) - standalone binary, no Python needed!
 * - llama.cpp + Cogito 8B (local AI) - standalone binary, no Python needed!
 * - ffmpeg (video processing) - via npm installer packages
 * - ffprobe (video analysis) - via npm installer packages
 *
 * Binaries are cached in .build-cache/ to avoid re-downloading.
 */

const { downloadYtDlp } = require('./download-ytdlp');
const { downloadWhisperCpp } = require('./download-whisper-cpp');
const { downloadLlamaCpp } = require('./download-llama-cpp');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '.build-cache');
const BIN_DIR = path.join(__dirname, '..', 'utilities', 'bin');
const MODELS_DIR = path.join(__dirname, '..', 'utilities', 'models');

async function downloadAllBinaries() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║      ClipChimp Binary Download Manager                    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Ensure directories exist
  for (const dir of [CACHE_DIR, BIN_DIR, MODELS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  try {
    // Download yt-dlp
    console.log('📥 [1/5] yt-dlp\n');
    await downloadYtDlp();

    // Download whisper.cpp (standalone binary + model)
    console.log('\n📥 [2/5] whisper.cpp (standalone - no Python needed!)\n');
    await downloadWhisperCpp();

    // Download llama.cpp + Cogito 8B model (standalone binary for local AI)
    console.log('\n📥 [3/5] llama.cpp + Cogito 8B (local AI - no Python needed!)\n');
    await downloadLlamaCpp();

    // FFmpeg and FFprobe are handled by npm packages
    console.log('\n✅ [4/5] FFmpeg - Using @ffmpeg-installer npm package');
    console.log('   No download needed - managed by npm');

    console.log('\n✅ [5/5] FFprobe - Using @ffprobe-installer npm package');
    console.log('   No download needed - managed by npm');

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║         All Binaries Ready! ✅                            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log('Summary:');
    console.log('  ✅ yt-dlp:         utilities/bin/');
    console.log('  ✅ whisper.cpp:    utilities/bin/');
    console.log('  ✅ whisper models: utilities/models/ (tiny, base)');
    console.log('  ✅ llama.cpp:      utilities/bin/');
    console.log('  ✅ cogito model:   utilities/models/llama/ (8B Q6_K)');
    console.log('  ✅ ffmpeg:         node_modules/@ffmpeg-installer/');
    console.log('  ✅ ffprobe:        node_modules/@ffprobe-installer/');
    console.log('\n💾 Cached in: .build-cache/\n');

  } catch (error) {
    console.error('\n╔═══════════════════════════════════════════════════════════╗');
    console.error('║            Binary Download Failed ❌                      ║');
    console.error('╚═══════════════════════════════════════════════════════════╝\n');
    console.error(`Error: ${error.message}\n`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  downloadAllBinaries();
}

module.exports = { downloadAllBinaries };
