// ClipChimp/electron/config/environment.ts
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
      allowUnsafeEval: true,
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
 * Get the current environment configuration based on NODE_ENV
 */
export function getEnvironmentConfig(): ElectronEnvironmentConfig {
  const env = process.env.NODE_ENV || 'production';
  return env === 'development' ? developmentConfig : productionConfig;
}

export const environmentConfig = getEnvironmentConfig();
