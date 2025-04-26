# Clippy Development Guide

This guide is intended for developers who want to contribute to the Clippy video downloader project.

## Architecture Overview

Clippy is built using a modern web application architecture:

### Backend (NestJS)

- **Main Module**: Central module that coordinates all functionality
- **Downloader Module**: Handles video downloading using yt-dlp
- **FFmpeg Module**: Processes videos (fixing aspect ratio, creating thumbnails)
- **WebSockets**: Provides real-time progress updates

### Frontend (Angular)

- **Components**: Modular UI elements
- **Services**: Handle business logic and API communication
- **Models**: TypeScript interfaces for data structures
- **Material Design**: UI component framework

## Development Environment Setup

Follow the [Installation Guide](INSTALLATION.md) to set up your initial development environment.

### Additional Development Dependencies

Install these global dependencies for development:

```bash
npm install -g @nestjs/cli
npm install -g @angular/cli
```

## Backend Development

### Project Structure

```
backend/src/
├── main.ts              # Application entry point
├── app.module.ts        # Main module
├── app.controller.ts    # Main controller
├── app.service.ts       # Main service
├── common/              # Shared resources
│   ├── dto/             # Data Transfer Objects
│   └── interfaces/      # TypeScript interfaces
├── downloader/          # Video downloader module
│   ├── downloader.module.ts
│   ├── downloader.controller.ts
│   ├── downloader.service.ts
│   └── interfaces/
└── ffmpeg/              # FFmpeg processing module
    ├── ffmpeg.module.ts
    ├── ffmpeg.service.ts
    └── interfaces/
```

### Creating New Features

1. **Generate a new module**:
   ```bash
   cd backend
   nest generate module feature-name
   ```

2. **Generate controller and service**:
   ```bash
   cd backend
   nest generate controller feature-name
   nest generate service feature-name
   ```

3. **Register with the main app module** (typically done automatically)

4. **Add necessary endpoints** in the controller and implement business logic in the service

### WebSocket Communication

The `DownloaderService` implements WebSocket Gateway functionality:

```typescript
@WebSocketGateway({ cors: true })
@Injectable()
export class DownloaderService {
  @WebSocketServer()
  server: Server;
  
  // Use this to send real-time updates
  // Example: this.server.emit('download-progress', { progress: 50 });
}
```

### Adding a New Download Provider

While yt-dlp handles most video sites automatically, you might want to add specialized handling for certain sites:

1. Create a new method in `DownloaderService` for the site
2. Add specialized options for yt-dlp based on the site's requirements
3. Implement any pre/post-processing specific to that site

### Error Handling

Follow these guidelines for error handling:

1. Use try-catch blocks for error-prone operations
2. Log errors with appropriate detail
3. Return structured error responses
4. Emit socket events for real-time error notifications

Example:
```typescript
try {
  // Code that might fail
} catch (error) {
  this.logger.error('Operation failed', error);
  this.server.emit('download-failed', error.message);
  throw new HttpException('Download failed: ' + error.message, HttpStatus.BAD_REQUEST);
}
```

## Frontend Development

### Project Structure

```
frontend/src/app/
├── components/           # UI components
│   ├── download-form/    # Video URL input and options
│   ├── download-history/ # List of downloaded videos
│   ├── download-progress/ # Progress indicators
│   └── settings/         # Application settings
├── services/             # Business logic and API communication
│   ├── api.service.ts    # HTTP API calls
│   ├── socket.service.ts # WebSocket communication
│   └── settings.service.ts # User settings management
├── models/               # Data interfaces
│   ├── download.model.ts
│   └── settings.model.ts
├── app.component.ts      # Root component
├── app.module.ts         # Main module
└── app-routing.module.ts # Router configuration
```

### Creating New Components

```bash
cd frontend
ng generate component components/feature-name
```

### Creating New Services

```bash
cd frontend
ng generate service services/service-name
```

### Angular Material

The project uses Angular Material for UI components. Follow these guidelines:

1. Import required modules in `app.module.ts`
2. Use consistent styling with the existing UI
3. Follow Material Design guidelines for UI/UX decisions

### Real-time Updates with Socket.io

The `SocketService` provides methods for listening to WebSocket events:

```typescript
// Example of subscribing to events
this.socketService.onDownloadProgress().subscribe(
  (progress: DownloadProgress) => {
    // Handle progress update
  }
);
```

### State Management

The application uses simple service-based state management:

1. Services maintain application state
2. Components subscribe to services to receive updates
3. Components call service methods to update state

For more complex state requirements, consider adding NgRx.

## Testing

### Backend Testing

Run tests with:

```bash
cd backend
npm run test       # Unit tests
npm run test:e2e   # End-to-end tests
```

Create new tests in the `test` folder, following the naming convention:
- `*.spec.ts` for unit tests
- `*.e2e-spec.ts` for end-to-end tests

### Frontend Testing

Run tests with:

```bash
cd frontend
ng test
```

Create tests alongside the components/services they test, using the `.spec.ts` suffix.

## Building for Production

See the [Installation Guide](INSTALLATION.md) for production build instructions.

## Code Style and Guidelines

### TypeScript

- Use explicit typing where possible
- Use interfaces for data structures
- Follow the [TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)

### NestJS

- Follow the [NestJS documentation](https://docs.nestjs.com/) for best practices
- Use dependency injection appropriately
- Separate concerns with modules, controllers, and services

### Angular

- Follow the [Angular Style Guide](https://angular.io/guide/styleguide)
- Create small, focused components
- Use reactive programming with RxJS where appropriate

### Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
type(scope): description

[optional body]

[optional footer]
```

Types:
- `feat`: New features
- `fix`: Bug fixes
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Test additions or changes
- `chore`: Build process or tooling changes

## Pull Request Process

1. Create a branch for your changes
2. Make your changes with appropriate tests
3. Run tests and ensure they pass
4. Update documentation as needed
5. Submit a pull request with a clear description of the changes

## API Documentation

The REST API supports the following endpoints:

### Downloader API

- `POST /api/downloader` - Start a video download
- `GET /api/downloader/history` - Get download history
- `DELETE /api/downloader/history/:id` - Remove item from history
- `DELETE /api/downloader/history` - Clear all history
- `GET /api/downloader/file/:id` - Download a file
- `GET /api/downloader/stream/:id` - Stream a file
- `GET /api/downloader/check?url=X` - Check if URL is valid

### WebSocket Events

- `download-progress` - Real-time download progress
- `processing-progress` - Video processing progress
- `download-history-updated` - History list was updated
- `download-started` - Download has started
- `download-completed` - Download completed successfully
- `download-failed` - Download failed with error