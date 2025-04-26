# Clippy Installation Guide

This guide walks you through setting up Clippy for development and production.

## Prerequisites

Before installing Clippy, you need to have the following software installed:

1. **Node.js (16+)** - Download from [nodejs.org](https://nodejs.org/)
2. **FFmpeg** - Required for video processing
3. **yt-dlp** - Required for video downloading

### Installing FFmpeg

#### Windows
1. Download the FFmpeg build from [ffmpeg.org](https://ffmpeg.org/download.html)
2. Extract the archive and add the bin folder to your PATH environment variable

#### macOS
```bash
brew install ffmpeg
```

#### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install ffmpeg
```

### Installing yt-dlp

#### Windows
1. Download the latest yt-dlp.exe from [yt-dlp GitHub releases](https://github.com/yt-dlp/yt-dlp/releases)
2. Place it in a directory that's in your PATH or add its location to PATH

#### macOS
```bash
brew install yt-dlp
```

#### Linux (Ubuntu/Debian)
```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
```

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/clippy.git
   cd clippy
   ```

2. Install dependencies for both backend and frontend:
   ```bash
   npm run install:all
   ```

## Development Setup

To run both the backend and frontend in development mode:

```bash
npm start
```

This will:
- Start the NestJS backend on http://localhost:3000
- Start the Angular frontend on http://localhost:4200

### Running Backend Only

```bash
npm run start:backend
```

### Running Frontend Only

```bash
npm run start:frontend
```

## Production Setup

### Building the Apps

```bash
npm run build
```

This builds both the backend and frontend applications.

### Backend Deployment

The built backend is located in `backend/dist/` and can be started with:

```bash
cd backend
npm run start:prod
```

For production deployment, you might want to use a process manager like PM2:

```bash
npm install -g pm2
cd backend
pm2 start dist/main.js --name clippy-backend
```

### Frontend Deployment

The built frontend is located in `frontend/dist/clippy-frontend` and can be deployed to any static file hosting or web server like Nginx or Apache.

#### Nginx Example Configuration

```nginx
server {
    listen 80;
    server_name yourdomainname.com;
    root /path/to/clippy/frontend/dist/clippy-frontend;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Configure WebSocket for real-time updates
    location /socket.io {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Configuration

### Backend Environment Variables

Create a `.env` file in the backend directory with the following variables:

```
PORT=3000
DOWNLOAD_DIR=/path/to/downloads
MAX_CONCURRENT_DOWNLOADS=3
```

### Frontend Environment

Update the API URL in `frontend/src/environments/environment.prod.ts` to point to your production backend:

```typescript
export const environment = {
  production: true,
  apiUrl: 'https://your-api-domain.com'
};
```

## Troubleshooting

### Common Issues

1. **Missing yt-dlp or FFmpeg**:
   - Ensure these dependencies are installed and available in your PATH
   - You can test with `yt-dlp --version` and `ffmpeg -version`

2. **CORS Issues**:
   - If you're hosting frontend and backend on different domains, ensure the CORS settings in `main.ts` are correctly configured

3. **WebSocket Connection Failures**:
   - Check that your proxy configuration properly forwards WebSocket connections
   - Ensure firewalls allow WebSocket traffic

4. **Permission Issues**:
   - Make sure the application has write permissions to the download directory

For more help, please create an issue in the GitHub repository.