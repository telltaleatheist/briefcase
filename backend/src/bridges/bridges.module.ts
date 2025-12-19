// backend/src/bridges/bridges.module.ts
import { Global, Module } from '@nestjs/common';
import { LlamaManager } from './llama-manager';

/**
 * Bridges Module - Provides binary bridge services globally
 * This module is Global so LlamaManager can be used across the application
 * without creating circular dependencies
 */
@Global()
@Module({
  providers: [LlamaManager],
  exports: [LlamaManager],
})
export class BridgesModule {}
