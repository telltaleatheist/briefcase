// backend/src/config/api-keys.controller.ts
import { Controller, Get, Post, Body, Logger } from '@nestjs/common';
import { ApiKeysService, ApiKeysConfig } from './api-keys.service';

@Controller('api/config/api-keys')
export class ApiKeysController {
  private readonly logger = new Logger(ApiKeysController.name);

  constructor(private readonly apiKeysService: ApiKeysService) {}

  @Get()
  getConfig(): ApiKeysConfig {
    return this.apiKeysService.getConfig();
  }

  @Post()
  updateConfig(@Body() updates: Partial<ApiKeysConfig>): { success: boolean } {
    try {
      this.apiKeysService.updateConfig(updates);
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to update API keys config: ${(error as Error).message}`);
      return { success: false };
    }
  }

  @Post('clear')
  clearKeys(): { success: boolean } {
    try {
      this.apiKeysService.clearAllKeys();
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to clear API keys: ${(error as Error).message}`);
      return { success: false };
    }
  }
}
