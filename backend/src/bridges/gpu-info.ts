/**
 * GPU/VRAM detection shared by ModelManagerService (model recommendations) and
 * LlamaManager (GPU layer-offload math). Pure function — no NestJS DI.
 */

import * as os from 'os';
import { execSync } from 'child_process';
import { Logger } from '@nestjs/common';

const logger = new Logger('GpuInfo');

export interface DetectedGpu {
  name: string;
  vramGB: number;
  driver?: string;
}

/**
 * Detect the primary GPU and its VRAM. On Apple Silicon, VRAM is reported as
 * total system RAM (unified memory). Returns null when no suitable GPU is found.
 */
export function detectGpuVram(): DetectedGpu | null {
  try {
    if (process.platform === 'win32') {
      // NVIDIA via nvidia-smi
      try {
        const out = execSync(
          'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits',
          { encoding: 'utf8', timeout: 5000, windowsHide: true },
        ).trim();
        if (out) {
          const parts = out.split(',').map((s) => s.trim());
          if (parts.length >= 2) {
            const vramMB = parseInt(parts[1], 10);
            return {
              name: parts[0],
              vramGB: Math.round((vramMB / 1024) * 10) / 10,
              driver: parts[2] || undefined,
            };
          }
        }
      } catch {
        // NVIDIA not available; try WMI
      }

      try {
        const wmic = execSync('wmic path win32_VideoController get Name,AdapterRAM /format:csv', {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        }).trim();
        const lines = wmic.split('\n').filter((l) => l.trim() && !l.includes('Node,'));
        for (const line of lines) {
          const parts = line.split(',');
          if (parts.length >= 3) {
            const adapterRAM = parseInt(parts[1], 10);
            const name = parts[2]?.trim();
            if (adapterRAM > 0 && name && !name.toLowerCase().includes('microsoft basic')) {
              const vramGB = Math.round((adapterRAM / 1024 ** 3) * 10) / 10;
              if (vramGB >= 2) return { name, vramGB };
            }
          }
        }
      } catch {
        // WMI failed
      }
    } else if (process.platform === 'darwin') {
      try {
        const output = execSync('system_profiler SPDisplaysDataType -json', {
          encoding: 'utf8',
          timeout: 5000,
        });
        const displays = JSON.parse(output).SPDisplaysDataType || [];
        for (const display of displays) {
          const name = display.sppci_model || display._name || 'Unknown GPU';
          const vramString = display.spdisplays_vram || display.spdisplays_vram_shared || '';
          let vramGB = 0;
          if (vramString.includes('GB')) {
            vramGB = parseFloat(vramString);
          } else if (vramString.includes('MB')) {
            vramGB = parseFloat(vramString) / 1024;
          } else if (name.includes('Apple')) {
            // Apple Silicon: unified memory — report total system RAM.
            vramGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
          }
          if (vramGB >= 2) {
            return { name, vramGB: Math.round(vramGB * 10) / 10 };
          }
        }
      } catch (err) {
        logger.warn(`Failed to detect macOS GPU: ${err}`);
      }
    } else {
      // Linux — NVIDIA via nvidia-smi
      try {
        const out = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', {
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
        if (out) {
          const parts = out.split(',').map((s) => s.trim());
          if (parts.length >= 2) {
            const vramMB = parseInt(parts[1], 10);
            return { name: parts[0], vramGB: Math.round((vramMB / 1024) * 10) / 10 };
          }
        }
      } catch {
        // NVIDIA not available on Linux
      }
    }
  } catch (err) {
    logger.warn(`GPU detection error: ${err}`);
  }

  return null;
}
