import {
  Controller,
  Post,
  Get,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { RelinkingService, RelinkOptions, RelinkProgress } from './relinking.service';
import { LibraryManagerService } from './library-manager.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Controller('database/relink')
export class RelinkingController {
  private readonly logger = new Logger(RelinkingController.name);
  private relinkingInProgress: boolean = false;

  constructor(
    private relinkingService: RelinkingService,
    private libraryManagerService: LibraryManagerService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Get current relinking status
   */
  @Get('status')
  async getStatus() {
    const activeLibrary = this.libraryManagerService.getActiveLibrary();

    return {
      relinkingInProgress: this.relinkingInProgress,
      activeLibrary: activeLibrary
        ? {
            id: activeLibrary.id,
            name: activeLibrary.name,
            clipsFolderPath: activeLibrary.clipsFolderPath,
          }
        : null,
    };
  }

  /**
   * Preview relinking (dry run)
   *
   * Body:
   * {
   *   targetPath: "/Volumes/Callisto/clips",
   *   copyMissingFiles: true  // Optional: copy missing files to target
   * }
   */
  @Post('preview')
  async preview(@Body() body: { targetPath: string; copyMissingFiles?: boolean }) {
    if (this.relinkingInProgress) {
      throw new HttpException(
        'Relinking already in progress',
        HttpStatus.CONFLICT
      );
    }

    const activeLibrary = this.libraryManagerService.getActiveLibrary();
    if (!activeLibrary) {
      throw new HttpException(
        'No active library. Please select a library first.',
        HttpStatus.BAD_REQUEST
      );
    }

    try {
      this.relinkingInProgress = true;
      this.logger.log('=== Starting Relinking Preview ===');

      const result = await this.relinkingService.relinkByHash(
        {
          targetPath: body.targetPath,
          dryRun: true,
          copyMissingFiles: body.copyMissingFiles || false,
        },
        (progress: RelinkProgress) => {
          // Emit progress events to frontend
          this.eventEmitter.emit('relink.progress', progress);
        }
      );

      this.logger.log('=== Preview Complete ===');
      this.relinkingInProgress = false;

      return {
        success: true,
        result,
        message: 'Preview completed successfully. No changes were made.',
      };

    } catch (error: any) {
      this.relinkingInProgress = false;
      this.logger.error(`Preview failed: ${error.message}`, error.stack);

      throw new HttpException(
        {
          success: false,
          message: `Preview failed: ${error.message}`,
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Run actual relinking
   *
   * Body:
   * {
   *   targetPath: "/Volumes/Callisto/clips",
   *   updateLibraryPath: true,  // Update library's clipsFolderPath to match
   *   copyMissingFiles: true  // Optional: copy missing files to target
   * }
   */
  @Post('run')
  async relink(@Body() body: { targetPath: string; updateLibraryPath?: boolean; copyMissingFiles?: boolean }) {
    if (this.relinkingInProgress) {
      throw new HttpException(
        'Relinking already in progress',
        HttpStatus.CONFLICT
      );
    }

    const activeLibrary = this.libraryManagerService.getActiveLibrary();
    if (!activeLibrary) {
      throw new HttpException(
        'No active library. Please select a library first.',
        HttpStatus.BAD_REQUEST
      );
    }

    const confirmed = true; // In real app, this would come from UI confirmation

    if (!confirmed) {
      throw new HttpException(
        'Relinking cancelled',
        HttpStatus.BAD_REQUEST
      );
    }

    try {
      this.relinkingInProgress = true;
      this.logger.log('=== Starting Actual Relinking ===');

      const result = await this.relinkingService.relinkByHash(
        {
          targetPath: body.targetPath,
          dryRun: false,
          copyMissingFiles: body.copyMissingFiles || false,
        },
        (progress: RelinkProgress) => {
          // Emit progress events to frontend
          this.eventEmitter.emit('relink.progress', progress);
        }
      );

      // If requested, update library's clips folder path
      if (body.updateLibraryPath && result.success) {
        this.logger.log(`Updating library clips folder path to: ${body.targetPath}`);
        this.libraryManagerService.updateLibraryClipsFolder(
          activeLibrary.id,
          body.targetPath
        );
      }

      this.logger.log('=== Relinking Complete ===');
      this.relinkingInProgress = false;

      return {
        success: true,
        result,
        message: result.success
          ? 'Relinking completed successfully!'
          : 'Relinking completed with errors. Check the results below.',
      };

    } catch (error: any) {
      this.relinkingInProgress = false;
      this.logger.error(`Relinking failed: ${error.message}`, error.stack);

      throw new HttpException(
        {
          success: false,
          message: `Relinking failed: ${error.message}`,
          error: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get relinking instructions/help
   */
  @Get('instructions')
  getInstructions() {
    return {
      title: 'Relink Videos by File Hash',
      description: 'Update database paths to point to files in a new location by matching file hashes',
      steps: [
        {
          step: 1,
          title: 'Backup',
          description: 'A backup of your database will be created automatically',
        },
        {
          step: 2,
          title: 'Scan Target Folder',
          description: 'The system will scan the target folder and compute file hashes',
        },
        {
          step: 3,
          title: 'Match by Hash',
          description: 'Files will be matched to database entries using hash comparison',
        },
        {
          step: 4,
          title: 'Update Paths',
          description: 'Database paths will be updated to point to the new file locations',
        },
      ],
      warnings: [
        'Ensure all files have been copied to the target location before relinking',
        'Files are matched by hash, so they must be identical to the originals',
        'A backup will be created, but it\'s recommended to create your own backup first',
        'The relinking process may take several minutes for large libraries (5000+ videos)',
      ],
    };
  }
}
