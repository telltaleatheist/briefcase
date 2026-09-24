/**
 * Download and cache all required binaries for Briefcase
 *
 * This script orchestrates downloading all binaries needed for the app:
 * - yt-dlp (video downloader)
 * - ffmpeg (video processing) - via npm installer packages
 * - ffprobe (video analysis) - via npm installer packages
 *
 * No AI binaries: transcription and analysis run on Crucible (P7).
 *
 * Binaries are cached in .build-cache/ to avoid re-downloading.
 */

const { downloadYtDlp } = require('./download-ytdlp');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '.build-cache');
const BIN_DIR = path.join(__dirname, '..', 'utilities', 'bin');

async function downloadAllBinaries() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║      Briefcase Binary Download Manager                    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  // Ensure directories exist
  for (const dir of [CACHE_DIR, BIN_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  try {
    // Download yt-dlp
    console.log('📥 [1/3] yt-dlp\n');
    await downloadYtDlp();

    // FFmpeg and FFprobe are handled by npm packages
    console.log('\n✅ [2/3] FFmpeg - Using @ffmpeg-installer npm package');
    console.log('   No download needed - managed by npm');

    console.log('\n✅ [3/3] FFprobe - Using @ffprobe-installer npm package');
    console.log('   No download needed - managed by npm');

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║         All Binaries Ready! ✅                            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log('Summary:');
    console.log('  ✅ yt-dlp:         utilities/bin/');
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
