# Windows Setup & Dependency Installation Guide

This document explains how Clippy handles dependency installation on Windows, including the new automated setup system with portable dependencies and optional AI features.

## Overview

Clippy now features an intelligent dependency management system that:

1. **Checks for missing dependencies** on first run
2. **Offers portable installation** for most tools (no system PATH pollution)
3. **Asks permission** before installing anything
4. **Guides users through AI setup** with clear explanations
5. **Keeps dependencies isolated** in the app's data directory

## Architecture

### Dependency Categories

#### Required Dependencies (Portable)
These are installed in `%APPDATA%/Clippy/dependencies/bin/` and don't affect your system PATH:

- **FFmpeg** - Video processing and conversion
- **FFprobe** - Video metadata analysis (comes with FFmpeg)
- **yt-dlp** - Video downloading from various platforms
- **Python (Embedded)** - Required for audio transcription features

#### Optional Dependencies (System-Wide)
These are installed system-wide as they benefit from being available globally:

- **Ollama** - Local AI model runtime (optional, for AI features)

## How It Works

### First-Run Experience

1. **Dependency Check**
   - App starts and checks for required tools
   - Detects available package managers (Chocolatey, Scoop, or Winget)
   - Separates dependencies into required and optional categories

2. **User Permission**
   - Shows a clear dialog listing what needs to be installed
   - Explains why each dependency is needed
   - Provides estimated disk space requirements
   - Offers "Install", "Cancel", or "Manual Installation" options

3. **Portable Installation**
   - Downloads dependencies to app-specific directory
   - Extracts archives to isolated locations
   - Sets up environment variables for the session
   - No system PATH modifications needed

4. **AI Features Setup (Optional)**
   - Separate wizard guides through AI setup
   - Explains benefits and requirements clearly
   - Shows recommended model (Qwen 2.5 7B)
   - Allows advanced users to choose different models
   - Provides detailed information about disk space and RAM needs

### File Structure

```
%APPDATA%/Clippy/
├── dependencies/
│   ├── bin/
│   │   ├── ffmpeg.exe
│   │   ├── ffprobe.exe
│   │   ├── yt-dlp.exe
│   │   └── (other portable executables)
│   └── python/
│       ├── python.exe
│       ├── (embedded Python distribution)
│       └── Lib/
└── config.json
```

## Key Components

### 1. Dependency Checker
**File**: `electron/utilities/dependency-checker.ts`

Responsibilities:
- Check if dependencies are installed
- Detect version numbers
- Verify minimum version requirements
- Detect available package managers
- Categorize dependencies (required, optional, AI)

### 2. Portable Dependency Manager
**File**: `electron/utilities/portable-dependency-manager.ts`

Responsibilities:
- Download portable versions of dependencies
- Extract archives to app-specific directories
- Set up environment variables
- Provide paths to dependencies
- Calculate disk space usage
- Clean up old versions

### 3. Dependency Installer
**File**: `electron/utilities/dependency-installer.ts`

Responsibilities:
- Install system-wide dependencies using package managers
- Show progress during installation
- Handle errors and provide fallbacks
- Request admin privileges when needed
- Show manual installation instructions as fallback

### 4. AI Setup Wizard
**File**: `electron/utilities/ai-setup-wizard.ts`

Responsibilities:
- Guide users through AI feature setup
- Explain benefits and requirements
- Allow model selection
- Install Ollama system-wide
- Download and install AI models
- Verify installation success

### 5. Setup Service
**File**: `electron/services/setup-service.ts`

Responsibilities:
- Coordinate the entire setup process
- Show setup progress window
- Handle user decisions
- Manage installation flow
- Verify final setup success

## User Experience Flow

### Standard Setup (No AI)

```
1. App Starts
   ↓
2. Dependency Check
   ↓
3. [Missing Dependencies] → Show Dialog
   ↓
4. User Approves
   ↓
5. Download & Install Portable Dependencies
   ↓
6. Setup Complete → App Launches
```

### Setup with AI Features

```
1. Standard Setup Completes
   ↓
2. AI Features Dialog
   ├─ "Set Up AI Features" → Continue
   ├─ "Learn More" → Show Info → Loop back
   └─ "Skip for Now" → Skip AI
   ↓
3. Check Disk Space
   ↓
4. Install Ollama (system-wide)
   ↓
5. Model Selection
   ├─ Recommended: Qwen 2.5 7B
   ├─ Alternative: Llama 3.2 3B (lighter)
   └─ Alternative: Mistral 7B
   ↓
6. Download Selected Model (with progress)
   ↓
7. Verify Installation
   ↓
8. Success Message → App Launches
```

## Building for Windows

### Prerequisites on Development Machine (Mac/Linux)

- Node.js 18+
- npm
- electron-builder (installed via npm)

### Build Commands

```bash
# Standard build
npm run package:win

# This will create:
# - dist-electron/Clippy Setup X.X.X.exe (NSIS installer)
```

### What the Installer Includes

The Windows installer includes:
- Electron app with your code
- Frontend (Angular) compiled assets
- Backend (NestJS) compiled code
- Setup system for dependency management
- Configuration dialogs
- Setup progress UI

**What it DOESN'T include:**
- FFmpeg, FFprobe (downloaded on first run)
- yt-dlp (downloaded on first run)
- Python (downloaded on first run)
- Ollama (optional, installed if user chooses)
- AI models (optional, downloaded if user chooses)

### Advantages of This Approach

1. **Smaller Installer** (~50-100 MB instead of 200-500 MB)
2. **Always Up-to-Date Dependencies** - Downloads latest versions
3. **User Choice** - Users control what gets installed
4. **Isolated Environment** - No conflicts with existing installations
5. **Easy Updates** - Can update dependencies independently

## Testing

### Testing Dependency Installation

1. Build Windows installer on Mac:
   ```bash
   npm run package:win
   ```

2. Transfer installer to Windows machine

3. Run installer

4. First launch will trigger setup wizard

### Testing Without Building

You can test the setup system in development:

```typescript
// In electron/main.ts
const setupService = new SetupService();
const setupSuccess = await setupService.runSetup();
```

## Package Manager Detection

The system automatically detects and uses available package managers in this order:

1. **Chocolatey** - Most comprehensive, preferred
   ```bash
   # Check if installed
   choco --version
   ```

2. **Scoop** - Lightweight, good alternative
   ```bash
   # Check if installed
   scoop --version
   ```

3. **Winget** - Built into Windows 11, fallback option
   ```bash
   # Check if installed
   winget --version
   ```

4. **None** - Manual installation fallback

## AI Models Available

### Qwen 2.5 (7B) - **RECOMMENDED**
- **Size**: ~4.7 GB
- **RAM**: 8 GB minimum
- **Best for**: General-purpose analysis, content generation
- **Strengths**: Balanced performance and quality

### Llama 3.2 (3B)
- **Size**: ~2.0 GB
- **RAM**: 4 GB minimum
- **Best for**: Lower-end hardware, basic tasks
- **Strengths**: Lightweight, fast

### Mistral (7B)
- **Size**: ~4.1 GB
- **RAM**: 8 GB minimum
- **Best for**: Creative content generation
- **Strengths**: Excellent at creative writing

## Troubleshooting

### Dependencies Not Found After Installation

**Problem**: App says dependencies are missing after installation completed.

**Solution**:
1. Check `%APPDATA%/Clippy/dependencies/bin/`
2. Verify files exist
3. Restart the app
4. Check logs in `%APPDATA%/Clippy/logs/`

### Ollama Installation Fails

**Problem**: Ollama won't install via package manager.

**Solutions**:
1. Install Chocolatey first:
   ```powershell
   Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
   ```

2. Or download Ollama manually from https://ollama.ai/download

### Model Download Stuck

**Problem**: AI model download appears frozen.

**Solutions**:
1. Large models (4-5GB) take time, be patient
2. Check internet connection
3. Check available disk space
4. Try canceling and restarting
5. Install model manually:
   ```bash
   ollama pull qwen2.5:7b
   ```

### Administrator Privileges Required

**Problem**: Installation requires admin rights but fails.

**Solutions**:
1. Right-click Clippy and "Run as Administrator"
2. Or install dependencies manually without package manager
3. Or use portable versions (no admin needed)

## Manual Installation Fallback

If automated installation fails, users can install manually:

### FFmpeg & FFprobe
1. Download from: https://www.gyan.dev/ffmpeg/builds/
2. Extract to: `%APPDATA%/Clippy/dependencies/bin/`
3. Or add to system PATH

### yt-dlp
1. Download from: https://github.com/yt-dlp/yt-dlp/releases
2. Place in: `%APPDATA%/Clippy/dependencies/bin/`
3. Rename to `yt-dlp.exe` if needed

### Python
1. Download Python 3.11 Embedded: https://www.python.org/downloads/
2. Extract to: `%APPDATA%/Clippy/dependencies/python/`

### Ollama
1. Download from: https://ollama.ai/download
2. Run installer
3. After installation, run: `ollama pull qwen2.5:7b`

## Future Enhancements

Planned improvements:
- [ ] Automatic dependency updates
- [ ] Model management UI
- [ ] Disk space cleanup tools
- [ ] Offline installer with bundled dependencies
- [ ] Portable app version (USB stick ready)

## Development Notes

### Adding New Dependencies

1. Add to `dependency-checker.ts`:
   ```typescript
   dependencies.push({
     name: 'new-tool',
     displayName: 'New Tool',
     command: 'new-tool --version',
     versionRegex: /(\d+\.\d+\.\d+)/,
     isInstalled: false,
     category: 'required'
   });
   ```

2. Add to `portable-dependency-manager.ts` if portable:
   ```typescript
   'new-tool': {
     name: 'new-tool',
     version: '1.0.0',
     downloadUrl: 'https://example.com/new-tool.zip',
     fileName: 'new-tool.zip'
   }
   ```

3. Add to `dependency-installer.ts` if system-wide:
   ```typescript
   const packageMap = {
     chocolatey: { 'new-tool': 'new-tool' },
     scoop: { 'new-tool': 'new-tool' },
     winget: { 'new-tool': 'Publisher.NewTool' }
   };
   ```

### Testing New Installations

```typescript
// Test portable installation
const manager = new PortableDependencyManager();
const success = await manager.installPortableDependency('ffmpeg', (progress) => {
  console.log(progress);
});

// Test AI wizard
const wizard = new AISetupWizard();
const result = await wizard.runWizard('chocolatey', (progress) => {
  console.log(progress);
});
```

## Security Considerations

1. **Downloads**: All downloads are from official sources
2. **Checksums**: Consider adding SHA256 verification (future)
3. **Isolation**: Portable deps run in app context only
4. **Permissions**: Admin only needed for Ollama, not for portable deps
5. **Privacy**: All AI models run locally, no data sent externally

## Resources

- [Electron Builder Docs](https://www.electron.build/)
- [Ollama Documentation](https://github.com/ollama/ollama)
- [FFmpeg Documentation](https://ffmpeg.org/documentation.html)
- [yt-dlp Documentation](https://github.com/yt-dlp/yt-dlp)

---

For questions or issues, check the logs at `%APPDATA%/Clippy/logs/main.log`
