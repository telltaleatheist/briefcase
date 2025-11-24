/**
 * Download and cache all required binaries for ClipChimp
 *
 * This script orchestrates downloading all binaries needed for the app:
 * - yt-dlp (video downloader)
 * - whisper (transcription)
 * - ffmpeg (video processing) - via npm installer packages
 * - ffprobe (video analysis) - via npm installer packages
 *
 * Binaries are cached in .build-cache/ to avoid re-downloading.
 */

const { downloadYtDlp } = require('./download-ytdlp');
const { downloadWhisper } = require('./download-whisper');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '.build-cache');
const BIN_DIR = path.join(__dirname, '..', 'utilities', 'bin');

async function downloadAllBinaries() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║      ClipChimp Binary Download Manager                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Ensure directories exist
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  try {
    // Download yt-dlp
    console.log('📥 [1/4] yt-dlp\n');
    await downloadYtDlp();

    // Download whisper
    console.log('\n📥 [2/4] Whisper\n');
    await downloadWhisper();

    // FFmpeg and FFprobe are handled by npm packages
    console.log('\n✅ [3/4] FFmpeg - Using @ffmpeg-installer npm package');
    console.log('   No download needed - managed by npm');

    console.log('\n✅ [4/4] FFprobe - Using @ffprobe-installer npm package');
    console.log('   No download needed - managed by npm');

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║         All Binaries Ready! ✅                            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log('Summary:');
    console.log('  ✅ yt-dlp:  utilities/bin/');
    console.log('  ✅ whisper: utilities/bin/');
    console.log('  ✅ ffmpeg:  node_modules/@ffmpeg-installer/');
    console.log('  ✅ ffprobe: node_modules/@ffprobe-installer/');
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
