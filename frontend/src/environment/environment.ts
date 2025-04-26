// src/config/environment.ts
export const environment = {
    production: true,
    apiBaseUrl: 'http://localhost:3000/api',
    socketIoConfig: {
        url: 'http://localhost:3000',
        options: {
        path: '/socket.io'
        }
    }
};
