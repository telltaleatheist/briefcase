// Build CORS origins dynamically based on actual running port
const port = process.env.PORT || 3000;

export const environment = {
  production: process.env.NODE_ENV === 'production',
  port: port,
  apiPrefix: 'api',

  // CORS configuration - allow all origins for local network access
  cors: {
    origins: true,  // Accept all origins
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
