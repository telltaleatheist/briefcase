// clippy/backend/src/path/path.controller.ts
import { Controller, Get, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { PathService } from './path.service';

@Controller('path')
export class PathController {
  constructor(private readonly pathService: PathService) {}

  @Get('default')
  getDefaultPath() {
    return { 
      path: this.pathService.getDefaultDownloadPath(),
      success: true
    };
  }

  @Post('validate')
  validatePath(@Body() body: { path: string }) {
    try {
      const { path } = body;
      const isValid = this.pathService.isPathWritable(path);

      return {
        path,
        isValid,
        success: true
      };
    } catch (error: unknown) {
      throw new HttpException({
        status: HttpStatus.BAD_REQUEST,
        error: 'Invalid path provided',
        message: error instanceof Error ? (error as Error).message : String(error)
      }, HttpStatus.BAD_REQUEST);
    }
  }

  @Post('open-file-location')
  async openFileLocation(@Body() body: { filePath: string }) {
    try {
      const { filePath } = body;
      await this.pathService.openFileLocation(filePath);

      return {
        success: true,
        message: 'File location opened successfully'
      };
    } catch (error: unknown) {
      throw new HttpException({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'Failed to open file location',
        message: error instanceof Error ? (error as Error).message : String(error)
      }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}