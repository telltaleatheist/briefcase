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
 * Read the true (64-bit) GPU VRAM size on Windows from the display-adapter class
 * registry key (HardwareInformation.qwMemorySize). WMIC's AdapterRAM is a 32-bit
 * field capped at ~4GB that WRAPS for larger cards, so it can't be trusted to
 * size VRAM. Returns the largest adapter's byte count, or null if unavailable.
 */
function readWindowsGpuVramBytes(): number | null {
  const base =
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
  let best = 0;
  for (let i = 0; i < 8; i++) {
    const key = `${base}\\${String(i).padStart(4, '0')}`;
    try {
      const out = execSync(`reg query "${key}" /v HardwareInformation.qwMemorySize`, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      const m = out.match(/HardwareInformation\.qwMemorySize\s+REG_QWORD\s+0x([0-9a-fA-F]+)/);
      if (m) {
        const bytes = parseInt(m[1], 16);
        if (bytes > best) best = bytes;
      }
    } catch {
      // Subkey may not exist / not a GPU — keep scanning.
    }
  }
  return best > 0 ? best : null;
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
        // Prefer the trustworthy 64-bit registry size; never gate GPU capability
        // on WMIC's wrapping AdapterRAM.
        const regBytes = readWindowsGpuVramBytes();
        const lines = wmic.split('\n').filter((l) => l.trim() && !l.includes('Node,'));
        for (const line of lines) {
          const parts = line.split(',');
          if (parts.length >= 3) {
            const adapterRAM = parseInt(parts[1], 10);
            const name = parts[2]?.trim();
            if (!name || name.toLowerCase().includes('microsoft basic')) continue;
            const bytes = regBytes ?? (adapterRAM > 0 ? adapterRAM : 0);
            // Real discrete adapter but no trustworthy byte count → assume it's
            // usable for offload (>=4GB) rather than falling back to CPU-only.
            const vramGB = bytes > 0 ? Math.round((bytes / 1024 ** 3) * 10) / 10 : 4;
            return { name, vramGB };
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
