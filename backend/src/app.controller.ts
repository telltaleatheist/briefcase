// ClipChimp/backend/src/app.controller.ts
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * Health check endpoint for Electron main process
   * GET /api (due to global prefix)
   */
  @Get()
  getHealth(): { status: string; message: string } {
    return {
      status: 'ok',
      message: 'ClipChimp backend is running'
    };
  }
}