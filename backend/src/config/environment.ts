// Build CORS origins dynamically based on actual running port
const port = process.env.PORT || 3000;

// Use regex to allow any localhost port for development
const localhostRegex = /^http:\/\/localhost:\d+$/;
const loopbackRegex = /^http:\/\/127\.0\.0\.1:\d+$/;

export const environment = {
  production: process.env.NODE_ENV === 'production',
  port: port,
  apiPrefix: 'api',

  // Expanded CORS and socket configuration
  cors: {
    origins: [localhostRegex, loopbackRegex],
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
