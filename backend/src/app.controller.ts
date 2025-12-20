// ClipChimp/backend/src/app.controller.ts
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { LibraryManagerService } from './database/library-manager.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly libraryManager: LibraryManagerService,
  ) {}

  /**
   * Health check endpoint for Electron main process
   * GET /api (due to global prefix)
   * Returns both backend status and library readiness
   */
  @Get()
  getHealth(): { status: string; message: string; libraryReady: boolean; activeLibrary: string | null } {
    const activeLibrary = this.libraryManager.getActiveLibrary();
    const isReady = this.libraryManager.isDatabaseReady();

    return {
      status: 'ok',
      message: 'ClipChimp backend is running',
      libraryReady: isReady,
      activeLibrary: activeLibrary?.name || null,
    };
  }
}
