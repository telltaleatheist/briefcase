// Build CORS origins dynamically based on actual running port
const port = process.env.PORT || 3000;
const dynamicCorsOrigins = [
  `http://localhost:${port}`,  // Backend server (actual running port)
  'http://localhost:8080',     // Default Electron app
  'http://localhost:3000',     // Fallback backend port
  'http://localhost:3001',     // Alternative backend port
  'http://localhost:4200',     // Angular dev server
  '*'                          // Allow all origins as fallback
];

export const environment = {
  production: process.env.NODE_ENV === 'production',
  port: port,
  apiPrefix: 'api',

  // Expanded CORS and socket configuration
  cors: {
    origins: dynamicCorsOrigins,
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
