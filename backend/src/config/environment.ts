// clippy/backend/src/config/environment.ts
export const environment = {
  production: process.env.NODE_ENV === 'production',
  port: process.env.PORT || 3000,
  apiPrefix: 'api',
  cors: {
    origin: [
      'http://localhost:3000',  // Added backend server port
      'http://localhost:8080',  // Electron app
      'http://localhost:4200'   // Angular dev server
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
  },
  batchProcessing: {
    defaultMaxConcurrentDownloads: 2,
    enabled: true
  }
};