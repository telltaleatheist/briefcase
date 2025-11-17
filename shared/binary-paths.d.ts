export interface BinaryConfig {
    path: string;
    exists: boolean;
    source: 'bundled' | 'npm-package' | 'environment' | 'system' | 'not-found';
}
export interface BinariesConfig {
    ffmpeg: BinaryConfig;
    ffprobe: BinaryConfig;
    ytdlp: BinaryConfig;
}
export declare function getBinariesConfig(): BinariesConfig;
export declare function validateBinaries(): {
    valid: boolean;
    missing: string[];
    config: BinariesConfig;
};
export declare function getFfmpegPath(): string;
export declare function getFfprobePath(): string;
export declare function getYtDlpPath(): string;
