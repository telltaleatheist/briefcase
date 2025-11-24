// ClipChimp/backend/src/saved-links/web.controller.ts
import { Controller, Get, Res, Logger } from '@nestjs/common';
import { Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';

@Controller('saved')
export class WebController {
  private readonly logger = new Logger(WebController.name);

  /**
   * Serve the web interface HTML
   * GET /saved
   */
  @Get()
  serveWebInterface(@Res() res: Response) {
    this.logger.log('Serving web interface');
    this.logger.log(`Current directory (__dirname): ${__dirname}`);
    this.logger.log(`NODE_ENV: ${process.env.NODE_ENV}`);

    // Try multiple possible paths
    const possiblePaths = [
      // Development mode (running from src with ts-node or nest start)
      path.join(__dirname, '..', '..', 'src', 'saved-links', 'web', 'index.html'),
      // Development mode alternative
      path.join(__dirname, 'web', 'index.html'),
      // Production mode (from dist)
      path.join(__dirname, '..', 'saved-links', 'saved-links', 'web', 'index.html'),
      // Production mode alternative
      path.join(__dirname, '..', '..', 'saved-links', 'saved-links', 'web', 'index.html'),
    ];

    this.logger.log('Trying paths:');
    let htmlPath: string | null = null;
    for (const tryPath of possiblePaths) {
      this.logger.log(`  - ${tryPath} (exists: ${fs.existsSync(tryPath)})`);
      if (fs.existsSync(tryPath)) {
        htmlPath = tryPath;
        break;
      }
    }

    if (!htmlPath) {
      this.logger.error('HTML file not found in any expected location');
      return res.status(404).send('Web interface not found. Please rebuild the backend.');
    }

    this.logger.log(`Serving HTML from: ${htmlPath}`);
    return res.sendFile(htmlPath);
  }
}
