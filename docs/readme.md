# Clippy - Video Downloader

Clippy is a modern web application for downloading videos from various platforms including YouTube, TikTok, Twitter, Reddit, Vimeo, and more. It's built with NestJS for the backend and Angular for the frontend.

## Features

- Download videos from multiple platforms
- Multiple quality options (from 360p to 4K)
- Option to fix aspect ratio with blurred background
- Convert to MP4 format
- Browser cookie integration for accessing restricted content
- Real-time download progress updates
- Download history with video playback
- Modern, responsive UI

## Tech Stack

### Backend
- NestJS - A progressive Node.js framework
- WebSockets (Socket.io) - For real-time progress updates
- yt-dlp - Command-line program for downloading videos
- FFmpeg - For video processing and aspect ratio fixing

### Frontend
- Angular - A platform for building web applications
- Angular Material - UI component library
- RxJS - Reactive programming library
- Socket.io-client - For WebSocket communication

## Setup

### Prerequisites
- Node.js 16+ and npm
- FFmpeg and ytdlp are expected in a bin folder in the root directory, but if they aren't there, the system uses system versions
- FFmpeg installed on your system
- yt-dlp installed on your system

### Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/clippy.git
   cd clippy
   ```

2. Install dependencies for both backend and frontend:
   ```
   npm run install:all
   ```

3. Start the development servers:
   ```
   npm start
   ```

This will run both the backend server (NestJS) and the frontend development server (Angular).

- Backend API: http://localhost:3000
- Frontend application: http://localhost:4200

## Project Structure

```
clippy/
├── backend/                # NestJS backend
│   ├── src/                # Source code
│   │   ├── downloader/     # Video downloader module
│   │   ├── ffmpeg/         # FFmpeg processing module
│   │   └── ...
│   └── ...
├── frontend/               # Angular frontend
│   ├── src/
│   │   ├── app/            # Angular app
│   │   │   ├── components/ # UI components
│   │   │   ├── services/   # Services
│   │   │   └── ...
│   │   └── ...
│   └── ...
├── electron/               # Electron front end
│   └── main.ts             # starts nest js back end and angular front end inline
├── preload.json
└── ...

```

## Build for Production
```
npm run electron (builds and runs)
```

##Build for development
```
npm run electron:dev (builds and runs)
```

### Backend
```
cd backend
npm run build
backend is run within the electron environment - no need to run manually, so i didnt add a script to package.json for it
```

### Frontend
```
cd frontend
npm run build
frontend is run within the electron environment - no need to run manually, so i didnt add a script to package.json for it
```

This will generate production-ready files in the `frontend/dist` directory that can be served by any web server.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for the core downloading functionality
