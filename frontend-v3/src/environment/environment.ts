// src/config/environment.ts
export const environment = {
    production: true,
    // NOTE: This fallback URL is only used during development or if Electron IPC fails
    // In production, BackendUrlService retrieves the actual backend URL from Electron
    // which uses the dynamically assigned port (3000, 3001, or other available port)
    apiBaseUrl: 'http://localhost:3000/api', // Fallback only - actual URL comes from Electron
    socketIoConfig: {
        url: '', // Will be set dynamically from Electron
        options: {
            path: '/socket.io',
            autoConnect: false // Prevent auto-connection until URL is set
        }
    }
};
