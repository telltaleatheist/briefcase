# Frontend-v3 Migration Complete

## Changes Made

### 1. Electron Configuration
**File: `electron/environment.util.ts`**
- Changed all frontend path references from `frontend-v2` to `frontend-v3`
- Updated both development and packaged paths

### 2. Root Package.json
**File: `package.json`**
Updated build and install scripts:
- `install:frontend`: Now runs `cd frontend-v3 && npm install`
- `build:frontend`: Now runs `cd frontend-v3 && npm run build`
- `files` array: Changed from `frontend-v2/dist/frontend-v2/**/*` to `frontend-v3/dist/frontend-v3/**/*`

### 3. Frontend-v3 Angular Configuration
**File: `frontend-v3/angular.json`**
- Changed `outputPath` from `dist/creamsicle-angular` to `dist/frontend-v3`

**File: `frontend-v3/package.json`**
- Changed `name` from `creamsicle-angular` to `frontend-v3`

## How to Run

### Development Mode

1. **Install dependencies** (first time only):
   ```bash
   cd frontend-v3
   npm install
   cd ..
   ```

2. **Build the frontend**:
   ```bash
   cd frontend-v3
   npm run build
   cd ..
   ```

3. **Run the Electron app**:
   ```bash
   npm run electron:dev
   ```

   This will:
   - Build the backend
   - Build the frontend-v3
   - Build the Electron main process
   - Start the NestJS backend on port 3000 (or next available)
   - Start the HTTP server on port 3001 (or next available)
   - Launch Electron with frontend-v3

### Alternative: Run Backend and Frontend Separately

If you want to develop with hot-reload:

**Terminal 1 - Backend:**
```bash
cd backend
npm run start:dev
```

**Terminal 2 - Frontend:**
```bash
cd frontend-v3
npm start
```

**Terminal 3 - Electron (pointing to dev server):**
You'll need to modify the backend service to use a dev URL, or just access via browser at `http://localhost:4200`

## Verification

After running `npm run electron:dev`, you should see:
1. Electron window opens
2. New Angular frontend loads (with "Media Library" page)
3. Navigation shows only "Media Library" and "Video Editor"
4. Page has search filters, library list, and "Add from URL" button

## Directory Structure

```
Briefcase/
├── backend/               # NestJS backend (port 3000)
├── frontend-v2/          # Old frontend (deprecated)
├── frontend-v3/          # NEW frontend (Briefcase)
│   ├── dist/
│   │   └── frontend-v3/  # Built output
│   │       ├── browser/  # Browser-specific files
│   │       └── index.html
│   └── src/
│       └── app/
│           ├── pages/
│           │   └── library/  # Video library page (main entry)
│           ├── components/
│           │   ├── library-search-filters/
│           │   ├── task-selection-modal/
│           │   └── video-library/
│           └── services/
│               └── library.service.ts
├── electron/             # Electron wrapper
└── package.json          # Root build configuration
```

## Expected Ports

- **Backend (NestJS)**: 3000 (or next available)
- **Frontend Dev Server**: 4200 (when running `npm start` in frontend-v3)
- **Electron HTTP Server**: 3001 (or next available) - serves built frontend to Electron

## Troubleshooting

### "Frontend distribution directory not found"
Run the build command:
```bash
cd frontend-v3 && npm run build
```

### Port already in use
The app will automatically find the next available port. Check the Electron logs for the actual ports being used.

### Backend fails to start
1. Check that `backend/dist/main.js` exists
2. Run `npm run build:backend` from project root
3. Check for port conflicts on 3000

### Old frontend still showing
1. Clear the `dist` folder: `rm -rf frontend-v3/dist`
2. Rebuild: `cd frontend-v3 && npm run build`
3. Restart Electron

## Next Steps

1. ✅ Frontend-v3 is now wired up
2. 🔄 Test the library page UI
3. 🔄 Connect to real backend API (uncomment HTTP calls in `library.service.ts`)
4. 🔄 Add WebSocket support for real-time task updates
5. 🔄 Implement video player
6. 🔄 Add queue management UI
7. 🔄 Fix video editor page

## Notes

- Frontend-v2 is still in the codebase but no longer used
- All routes now point to frontend-v3
- The library service has stub methods ready for backend integration
- Dark mode is supported via the theme service
- All components follow Angular standalone component pattern
