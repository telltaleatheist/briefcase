"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBinariesConfig = getBinariesConfig;
exports.validateBinaries = validateBinaries;
exports.getFfmpegPath = getFfmpegPath;
exports.getFfprobePath = getFfprobePath;
exports.getYtDlpPath = getYtDlpPath;
const fs = require("fs");
const path = require("path");
function getPlatformFolder() {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === 'win32') {
        return 'win32-x64';
    }
    else if (platform === 'darwin') {
        return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    }
    else if (platform === 'linux') {
        return 'linux-x64';
    }
    return 'unknown';
}
function getBinaryName(baseName) {
    return process.platform === 'win32' ? `${baseName}.exe` : baseName;
}
function getYtDlpBinaryName() {
    const platform = process.platform;
    if (platform === 'win32') {
        return 'yt-dlp.exe';
    }
    else if (platform === 'darwin') {
        return 'yt-dlp_macos';
    }
    else {
        return 'yt-dlp_linux';
    }
}
function isPackaged() {
    return process.env.NODE_ENV === 'production' ||
        process.resourcesPath !== undefined ||
        process.defaultApp === false;
}
function getResourcesPath() {
    if (process.resourcesPath) {
        return process.resourcesPath;
    }
    return process.env.RESOURCES_PATH || path.join(process.cwd(), 'resources');
}
function getAppPath() {
    try {
        const { app } = require('electron');
        return app.getAppPath();
    }
    catch {
        return process.cwd();
    }
}
function findFfmpegPath() {
    const binaryName = getBinaryName('ffmpeg');
    const platformFolder = getPlatformFolder();
    if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
        return {
            path: process.env.FFMPEG_PATH,
            exists: true,
            source: 'environment'
        };
    }
    if (isPackaged()) {
        const resourcesPath = getResourcesPath();
        const possiblePaths = [
            path.join(resourcesPath, 'node_modules', '@ffmpeg-installer', platformFolder, binaryName),
            path.join(resourcesPath, 'backend', 'node_modules', '@ffmpeg-installer', platformFolder, binaryName),
            path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', platformFolder, binaryName),
        ];
        for (const candidatePath of possiblePaths) {
            if (fs.existsSync(candidatePath)) {
                return {
                    path: candidatePath,
                    exists: true,
                    source: 'bundled'
                };
            }
        }
    }
    try {
        const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
        if (ffmpegInstaller && ffmpegInstaller.path && fs.existsSync(ffmpegInstaller.path)) {
            return {
                path: ffmpegInstaller.path,
                exists: true,
                source: 'npm-package'
            };
        }
    }
    catch {
    }
    return {
        path: '',
        exists: false,
        source: 'not-found'
    };
}
function findFfprobePath() {
    const binaryName = getBinaryName('ffprobe');
    const platformFolder = getPlatformFolder();
    if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
        return {
            path: process.env.FFPROBE_PATH,
            exists: true,
            source: 'environment'
        };
    }
    if (isPackaged()) {
        const resourcesPath = getResourcesPath();
        const possiblePaths = [
            path.join(resourcesPath, 'node_modules', '@ffprobe-installer', platformFolder, binaryName),
            path.join(resourcesPath, 'backend', 'node_modules', '@ffprobe-installer', platformFolder, binaryName),
            path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@ffprobe-installer', platformFolder, binaryName),
        ];
        for (const candidatePath of possiblePaths) {
            if (fs.existsSync(candidatePath)) {
                return {
                    path: candidatePath,
                    exists: true,
                    source: 'bundled'
                };
            }
        }
    }
    try {
        const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
        if (ffprobeInstaller && ffprobeInstaller.path && fs.existsSync(ffprobeInstaller.path)) {
            return {
                path: ffprobeInstaller.path,
                exists: true,
                source: 'npm-package'
            };
        }
    }
    catch {
    }
    return {
        path: '',
        exists: false,
        source: 'not-found'
    };
}
function findYtDlpPath() {
    const binaryName = getYtDlpBinaryName();
    if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
        return {
            path: process.env.YT_DLP_PATH,
            exists: true,
            source: 'environment'
        };
    }
    if (isPackaged()) {
        const resourcesPath = getResourcesPath();
        const possiblePaths = [
            path.join(resourcesPath, 'utilities', 'bin', binaryName),
            path.join(resourcesPath, 'app.asar.unpacked', 'utilities', 'bin', binaryName),
        ];
        for (const candidatePath of possiblePaths) {
            if (fs.existsSync(candidatePath)) {
                return {
                    path: candidatePath,
                    exists: true,
                    source: 'bundled'
                };
            }
        }
    }
    const appPath = getAppPath();
    const possibleDevPaths = [
        path.join(appPath, 'utilities', 'bin', binaryName),
        path.join(__dirname, '..', 'utilities', 'bin', binaryName),
        path.join(__dirname, '..', '..', 'utilities', 'bin', binaryName),
    ];
    for (const candidatePath of possibleDevPaths) {
        if (fs.existsSync(candidatePath)) {
            return {
                path: candidatePath,
                exists: true,
                source: 'system'
            };
        }
    }
    return {
        path: '',
        exists: false,
        source: 'not-found'
    };
}
function getBinariesConfig() {
    return {
        ffmpeg: findFfmpegPath(),
        ffprobe: findFfprobePath(),
        ytdlp: findYtDlpPath()
    };
}
function validateBinaries() {
    const config = getBinariesConfig();
    const missing = [];
    if (!config.ffmpeg.exists) {
        missing.push('ffmpeg');
    }
    if (!config.ffprobe.exists) {
        missing.push('ffprobe');
    }
    if (!config.ytdlp.exists) {
        missing.push('yt-dlp');
    }
    return {
        valid: missing.length === 0,
        missing,
        config
    };
}
function getFfmpegPath() {
    return findFfmpegPath().path;
}
function getFfprobePath() {
    return findFfprobePath().path;
}
function getYtDlpPath() {
    return findYtDlpPath().path;
}
//# sourceMappingURL=binary-paths.js.map