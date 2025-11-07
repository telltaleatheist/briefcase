# Quick Fix Guide

Common issues and their solutions.

---

## better-sqlite3 Module Error (Electron)

### Symptoms
```
Error: The module 'better_sqlite3.node' was compiled against a different Node.js version
NODE_MODULE_VERSION 131 vs 135
ERR_DLOPEN_FAILED
```

### Solution
```bash
# From project root
npx @electron/rebuild -v 36.0.1 -w better-sqlite3
```

### Why?
Electron uses its own Node.js version (v135), different from system Node.js (v131). Native modules like better-sqlite3 must be compiled specifically for Electron.

---

## TypeScript Build Fails

### Symptoms
- `nest build` produces no output
- `dist/` folder is empty or missing files
- No errors shown but compilation doesn't complete

### Solution
```bash
# In backend directory
rm -f tsconfig.build.tsbuildinfo
npx tsc -p tsconfig.build.json
```

### Why?
The `.tsbuildinfo` cache file can become corrupted. Removing it forces a clean rebuild.

---

## Backend Won't Start

### Symptoms
```
Cannot find module '@/config/...'
```

### Solution
Check imports use relative paths, not `@/` aliases:
```typescript
// WRONG
import { Foo } from '@/config/foo';

// CORRECT
import { Foo } from '../config/foo';
```

### Why?
TypeScript path aliases aren't resolved in compiled JavaScript without additional tooling.

---

## Refresh Failed Error (Frontend)

### Symptoms
```
Refresh Failed
Failed to refresh batch status. Will try again later.
```

### Solution
Ensure backend is running on port 3000:
```bash
# In backend directory
npm run start:dev

# Or from project root
npm run electron:dev
```

### Why?
Frontend is polling `/api/downloader/batch/status` before backend is ready.

---

## Full Rebuild

If all else fails, perform a complete rebuild:

```bash
# 1. Clean everything
rm -rf node_modules
rm -rf backend/node_modules
rm -rf frontend/node_modules
rm -rf backend/dist
rm -rf frontend/dist

# 2. Install dependencies
npm install
cd backend && npm install
cd ../frontend && npm install
cd ..

# 3. Rebuild for Electron
npx @electron/rebuild -v 36.0.1 -w better-sqlite3

# 4. Build backend
cd backend
rm -f tsconfig.build.tsbuildinfo
npx tsc -p tsconfig.build.json
cd ..

# 5. Start application
npm run electron:dev
```

---

## Electron Version Check

If you need to check your Electron version:
```bash
cat package.json | grep '"electron"'
```

Current version: **36.0.1** (requires NODE_MODULE_VERSION 135)

---

## Common Commands

```bash
# Rebuild for Electron
npx @electron/rebuild -v 36.0.1 -w better-sqlite3

# Clean TypeScript build cache
rm -f backend/tsconfig.build.tsbuildinfo

# Start development
npm run electron:dev

# Build everything
npm run build:all

# Package for macOS (ARM)
npm run package:mac-arm64
```

---

**Last Updated:** November 6, 2025
