// ClipChimp/electron/config/environment.ts
import { app } from 'electron';

/**
 * Environment-specific configuration for Electron
 */

export interface ElectronEnvironmentConfig {
  isDevelopment: boolean;
  isProduction: boolean;
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    enableFileLogging: boolean;
    enableConsoleLogging: boolean;
  };
  security: {
    csp: {
      enableStrictCSP: boolean;
      allowUnsafeInline: boolean;
      allowUnsafeEval: boolean;
    };
    devTools: boolean;
  };
  backend: {
    startupTimeout: number; // milliseconds
    healthCheckRetries: number;
    healthCheckInitialDelay: number; // milliseconds
    healthCheckMaxDelay: number; // milliseconds
  };
}

const developmentConfig: ElectronEnvironmentConfig = {
  isDevelopment: true,
  isProduction: false,
  logging: {
    level: 'debug',
    enableFileLogging: true,
    enableConsoleLogging: true,
  },
  security: {
    csp: {
      enableStrictCSP: false,
      allowUnsafeInline: true,
      allowUnsafeEval: false,  // Disable unsafe-eval - Angular AOT doesn't need it
    },
    devTools: true,
  },
  backend: {
    startupTimeout: 30000, // 30 seconds for development (longer for debugging)
    healthCheckRetries: 15,
    healthCheckInitialDelay: 100,
    healthCheckMaxDelay: 5000,
  },
};

const productionConfig: ElectronEnvironmentConfig = {
  isDevelopment: false,
  isProduction: true,
  logging: {
    level: 'info',
    enableFileLogging: true,
    enableConsoleLogging: false, // Disable console logging in production
  },
  security: {
    csp: {
      enableStrictCSP: true,
      allowUnsafeInline: false, // Strict - no unsafe-inline
      allowUnsafeEval: false, // Strict - no unsafe-eval
    },
    devTools: false, // Disable DevTools in production
  },
  backend: {
    startupTimeout: 15000, // 15 seconds for production
    healthCheckRetries: 15,
    healthCheckInitialDelay: 100,
    healthCheckMaxDelay: 3000,
  },
};

/**
 * Get the current environment configuration based on NODE_ENV or app.isPackaged
 * Uses app.isPackaged as the primary indicator since NODE_ENV isn't always set
 */
export function getEnvironmentConfig(): ElectronEnvironmentConfig {
  // Check NODE_ENV first, then fall back to app.isPackaged
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === 'development') {
    return developmentConfig;
  }
  if (nodeEnv === 'production') {
    return productionConfig;
  }
  // NODE_ENV not set - use app.isPackaged as fallback
  // app.isPackaged is true when running from an asar or installed app
  return app.isPackaged ? productionConfig : developmentConfig;
}

export const environmentConfig = getEnvironmentConfig();
