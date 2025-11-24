# Dependency Management Guide

## Overview

ClipChimp uses a monorepo structure with separate `node_modules` directories:
- **Root**: Electron, build tools, and development dependencies
- **Backend**: NestJS backend with its own dependencies including @types packages
- **Frontend**: Angular frontend dependencies

## Automatic Dependency Installation

The build system now **automatically ensures backend dependencies are installed** before any build operation.

### Key Scripts

- **`postinstall`**: Automatically runs after `npm install` to install backend deps
- **`verify:deps`**: Checks if critical backend dependencies exist
- **`prebuild:all`**: Runs before `build:all` to verify/install backend deps
- **`build:backend`**: Now includes `npm install --prefer-offline` to ensure deps are present

## What This Prevents

✅ **Missing @types packages** - TypeScript type definitions are always installed
✅ **Build failures** - Dependencies are verified before compilation
✅ **Stale dependencies** - Backend deps are refreshed on every build

## Manual Installation

If you ever need to manually install dependencies:

```bash
# Install everything
npm run install:all

# Just backend
npm run install:backend

# Just frontend
npm run install:frontend

# Verify backend dependencies are present
npm run verify:deps
```

## Build Scripts

All build scripts now include dependency checks:

```bash
# Full build (with automatic dep verification)
npm run build:all

# Backend only (automatically installs deps first)
npm run build:backend

# Package for distribution (ensures everything is fresh)
npm run package:mac-arm64
npm run package:mac-arm64:fast  # Faster, skips clean but still checks deps
```

## Troubleshooting

If you encounter TypeScript errors about missing modules:

1. **First, try:** `npm run install:backend`
2. **If that fails:** `cd backend && rm -rf node_modules package-lock.json && npm install`
3. **Verify:** `npm run verify:deps`

## Configuration

- **backend/.npmrc**: Configures npm to prefer offline packages and use hoisted strategy
- **postinstall hook**: Ensures backend deps are installed after root installation
- **prebuild:all hook**: Verifies deps before any build operation

## Why This Approach?

The backend needs its own `node_modules` because:
1. It runs as a separate NestJS process inside Electron
2. It has different TypeScript configuration and dependencies
3. Some native modules (like better-sqlite3) need to be compiled for Electron's Node.js version

The automatic installation ensures these dependencies are always present without manual intervention.
