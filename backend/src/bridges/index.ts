/**
 * Bridges - Process wrappers for external binaries
 *
 * Provides clean interfaces to ffmpeg, ffprobe, whisper.cpp, and yt-dlp
 * with support for multiple concurrent processes and individualized feedback.
 *
 * Usage:
 *   import { getRuntimePaths, FfmpegBridge, FfprobeBridge, WhisperBridge, YtDlpBridge } from '../bridges';
 *
 *   const paths = getRuntimePaths();
 *   const ffmpeg = new FfmpegBridge(paths.ffmpeg);
 *   const ffprobe = new FfprobeBridge(paths.ffprobe);
 *   const ytdlp = new YtDlpBridge(paths.ytdlp, { ffmpegPath: paths.ffmpeg });
 *   const whisper = new WhisperBridge({
 *     binaryPath: paths.whisper,
 *     modelsDir: paths.whisperModelsDir,
 *     libraryPath: getWhisperLibraryPath(),
 *   });
 */

// Runtime path resolution
export {
  getRuntimePaths,
  getResourcesPath,
  isPackaged,
  getPlatformFolder,
  getBinaryExtension,
  verifyBinary,
  getWhisperLibraryPath,
  getLlamaLibraryPath,
  type RuntimePaths,
} from './runtime-paths';

// FFmpeg bridge
export {
  FfmpegBridge,
  type FfmpegProgress,
  type FfmpegProcessInfo,
  type FfmpegResult,
} from './ffmpeg-bridge';

// FFprobe bridge
export {
  FfprobeBridge,
  type StreamInfo,
  type FormatInfo,
  type ProbeResult,
  type MediaInfo,
} from './ffprobe-bridge';

// YT-DLP bridge
export {
  YtDlpBridge,
  type YtDlpProgress,
  type YtDlpProcessInfo,
  type YtDlpResult,
  type YtDlpVideoInfo,
  type YtDlpConfig,
} from './ytdlp-bridge';

// Whisper bridge
export {
  WhisperBridge,
  type WhisperProgress,
  type WhisperProcessInfo,
  type WhisperResult,
  type WhisperConfig,
  type WhisperGpuMode,
} from './whisper-bridge';

// Llama bridge (local AI)
export {
  LlamaBridge,
  type LlamaConfig,
  type LlamaProgress,
  type LlamaServerStatus,
  type LlamaGenerateResult,
} from './llama-bridge';

// Llama manager
export { LlamaManager, type LocalAIProgress } from './llama-manager';

// Bridges module
export { BridgesModule } from './bridges.module';
