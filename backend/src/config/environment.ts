import { EnvironmentUtil } from './environment.util';
import * as log from 'electron-log';
import * as fs from 'fs';

const initBinaryPaths = () => {
  const ytdlpPath = EnvironmentUtil.getBinaryPath('yt-dlp');
  const ffmpegPath = EnvironmentUtil.getBinaryPath('ffmpeg');
  const ffprobePath = EnvironmentUtil.getBinaryPath('ffprobe');
  
  // Log the results
  log.info(`Using yt-dlp: ${ytdlpPath} (exists: ${fs.existsSync(ytdlpPath)})`);
  log.info(`Using ffmpeg: ${ffmpegPath} (exists: ${fs.existsSync(ffmpegPath)})`);
  log.info(`Using ffprobe: ${ffprobePath} (exists: ${fs.existsSync(ffprobePath)})`);
  
  return {
    ytdlp: ytdlpPath,
    ffmpeg: ffmpegPath,
    ffprobe: ffprobePath
  };
};

// Initialize binary paths once at startup
const binaryPaths = initBinaryPaths();

export const environment = {
  production: process.env.NODE_ENV === 'production',
  port: process.env.PORT || 3000,
  apiPrefix: 'api',

  // Expanded CORS and socket configuration
  cors: {
    origins: [
      'http://localhost:3000',  // Backend server
      'http://localhost:8080',  // Electron app
      'http://localhost:4200'   // Angular dev server
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
  },

  socket: {
    path: '/socket.io',
    credentials: true
  },

  batchProcessing: {
    defaultMaxConcurrentDownloads: 2,
    enabled: true
  },

  // Binary paths (lazily evaluated)
  binaries: {
    get ytdlp() { return EnvironmentUtil.getBinaryPath('yt-dlp'); },
    get ffmpeg() { return EnvironmentUtil.getBinaryPath('ffmpeg'); },
    get ffprobe() { return EnvironmentUtil.getBinaryPath('ffprobe'); }
  }
};
