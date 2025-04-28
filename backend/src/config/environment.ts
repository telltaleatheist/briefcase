export const environment = {
  production: process.env.NODE_ENV === 'production',
  port: process.env.PORT || 3000,
  apiPrefix: 'api',

  // Expanded CORS and socket configuration
  cors: {
    origins: [
      'http://localhost:3000',  // Backend server
      'http://localhost:8080',  // Electron app
      'http://localhost:4200'   // Angular dev server
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
  },

  socket: {
    path: '/socket.io',
    credentials: true
  },

  batchProcessing: {
    defaultMaxConcurrentDownloads: 2,
    enabled: true
  },
};
