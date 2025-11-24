// ClipChimp/backend/src/common/dto/download.dto.ts
import { IsBoolean, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUrl, Max, Min, ValidateNested, IsArray } from 'class-validator';
import { Type } from 'class-transformer';

export class BatchConfigDto {
  @IsNumber()
  @Min(1)
  @Max(20)
  maxConcurrentDownloads: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean = true;

  @IsOptional()
  @IsBoolean()
  transcribeVideo?: boolean = false;

  @IsOptional()
  @IsBoolean()
  useRmsNormalization?: boolean = false;

  @IsOptional()
  @IsNumber()
  @Min(-20)
  @Max(20)
  rmsNormalizationLevel?: number = 0;

  @IsOptional()
  @IsBoolean()
  useCompression?: boolean = false;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  compressionLevel?: number = 5;
}

export class BatchDownloadDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DownloadVideoDto)
  downloads: DownloadVideoDto[];
}

export class DownloadVideoDto {
  @IsNotEmpty()
  @IsUrl({}, { message: 'Please provide a valid URL' })
  url: string;

  @IsOptional()
  @IsString()
  jobId?: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  outputDir?: string;

  @IsOptional()
  @IsIn(['360', '480', '720', '1080', '1440', '2160'], { 
    message: 'Quality must be one of: 360, 480, 720, 1080, 1440, 2160' 
  })
  quality?: string = '720';

  @IsOptional()
  @IsBoolean()
  convertToMp4?: boolean = true;

  @IsOptional()
  @IsBoolean()
  transcribeVideo?: boolean = false;

  @IsOptional()
  @IsBoolean()
  analyzeVideo?: boolean = false;

  @IsOptional()
  @IsBoolean()
  useRmsNormalization?: boolean = false;

  @IsOptional()
  @IsNumber()
  @Min(-20)
  @Max(20)
  rmsNormalizationLevel?: number = 0;

  @IsOptional()
  @IsBoolean()
  useCompression?: boolean = false;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  compressionLevel?: number = 5;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(60)
  fps?: number = 30;

  @IsOptional()
  @IsBoolean()
  useCookies?: boolean = true;

  @IsOptional()
  @IsString()
  @IsIn(['auto', 'chrome', 'firefox', 'edge', 'safari', 'brave', 'opera', ''], { 
    message: 'Browser must be one of: auto, chrome, firefox, edge, safari, brave, opera'
  })
  browser?: string = 'auto';

  @IsOptional()
  @IsBoolean()
  fixAspectRatio?: boolean = true;

  @IsOptional()
  @IsBoolean()
  normalizeAudio?: boolean = true;  // Default to true

  @IsOptional()
  @IsIn(['ebur128', 'rms', 'peak'])
  audioNormalizationMethod?: 'ebur128' | 'rms' | 'peak' = 'ebur128';  // Default to broadcast standard

  @IsOptional()
  @IsBoolean()
  shouldImport?: boolean = false;  // Auto-import to library after download (only for library downloads)

  @IsOptional()
  @IsBoolean()
  skipProcessing?: boolean = false;  // Skip automatic processing (fix-aspect-ratio, normalize) - used by analysis queue

  @IsOptional()
  @IsString()
  libraryId?: string;  // Library ID for database import
}

export class DownloadProgressDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  progress: number;

  @IsOptional()
  @IsString()
  task?: string;

  @IsOptional()
  @IsString()
  outputFile?: string;
  
  @IsOptional()
  @IsString()
  jobId?: string;
}

export class BatchJobStatusDto {
  @IsString()
  id: string;
  
  @IsString()
  url: string;
  
  @IsString()
  @IsIn(['queued', 'downloading', 'processing', 'completed', 'failed'])
  status: string;
  
  @IsOptional()
  @IsString()
  error?: string;
}