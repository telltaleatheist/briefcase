/**
 * Bridges - Process wrappers for external binaries
 *
 * Provides clean interfaces to ffmpeg, ffprobe and yt-dlp with support for
 * multiple concurrent processes and individualized feedback. (AI runs on
 * Crucible: Briefcase ships no whisper or llama binary of its own.)
 *
 * Usage:
 *   import { getRuntimePaths, FfmpegBridge, FfprobeBridge, YtDlpBridge } from '../bridges';
 *
 *   const paths = getRuntimePaths();
 *   const ffmpeg = new FfmpegBridge(paths.ffmpeg);
 *   const ffprobe = new FfprobeBridge(paths.ffprobe);
 *   const ytdlp = new YtDlpBridge(paths.ytdlp, { ffmpegPath: paths.ffmpeg });
 */

// Runtime path resolution
export {
  getRuntimePaths,
  getResourcesPath,
  isPackaged,
  getPlatformFolder,
  getBinaryExtension,
  verifyBinary,
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
