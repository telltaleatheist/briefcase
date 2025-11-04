# Python Configuration in Clippy

## Overview

Clippy uses Python for AI analysis and audio transcription features. To prevent version mismatch issues, **all Python usage is centralized through the `shared/python-config.ts` module**.

## Centralized Configuration

### Location
`shared/python-config.ts`

### Purpose
This module ensures that:
1. **Setup wizards** check the correct Python version
2. **Runtime services** use the same Python version
3. **Package installations** target the correct Python environment

### Why This Matters

**Problem**: Different parts of the app were using different Python versions:
- Setup wizard might check `python3.12`
- Runtime might use `python3`
- Packages installed for one version won't work in another

**Solution**: Single source of truth for Python configuration.

## Python Selection Priority

The `getPythonConfig()` function uses this priority order:

### macOS
1. **Conda environment** (if exists): `/opt/homebrew/Caskroom/miniconda/base/envs/metadata-generator/bin/python`
2. **System Python**: `python3`

### Windows
1. **System Python**: `python`

### Linux
1. **System Python**: `python3`

## How to Use

### In TypeScript/JavaScript Code

```typescript
import { getPythonCommand, getPythonConfig } from '../shared/python-config';

// Get just the command string
const pythonCmd = getPythonCommand();
// Example: "/opt/homebrew/Caskroom/miniconda/base/envs/metadata-generator/bin/python"

// Get full configuration
const config = getPythonConfig();
// {
//   command: "/opt/homebrew/Caskroom/miniconda/base/envs/metadata-generator/bin/python",
//   isConda: true,
//   fullPath: "/opt/homebrew/Caskroom/miniconda/base/envs/metadata-generator/bin/python"
// }
```

### Checking Package Availability

```typescript
import { checkPythonPackages } from '../shared/python-config';

const packages = await checkPythonPackages(['whisper', 'requests', 'openai']);
// { whisper: true, requests: true, openai: true }
```

### Validating Configuration

```typescript
import { validatePythonConfig } from '../shared/python-config';

const validation = await validatePythonConfig();
// {
//   valid: true,
//   command: "/opt/homebrew/...",
//   version: "Python 3.11.13"
// }
```

## Files Using Python

### Primary Runtime Files (MUST use centralized config)

1. **`backend/src/analysis/python-bridge.service.ts`**
   - Spawns Python processes for transcription and AI analysis
   - ✅ Uses `getPythonCommand()` from centralized config

2. **`electron/utilities/whisper-setup-wizard.ts`**
   - Checks Python availability and installs packages
   - ✅ Uses `getPythonCommand()` from centralized config

### Secondary Files (informational only)

3. **`electron/utilities/dependency-checker.ts`**
   - Checks if Python is installed (generic check)
   - ⚠️ Not used for runtime, only for system validation

4. **`electron/utilities/portable-dependency-manager.ts`**
   - Downloads portable Python for Windows deployments
   - ⚠️ Separate from runtime Python, only for packaging

## Modifying Python Configuration

### To Change the Python Path

**❌ WRONG** - Don't modify individual files:
```typescript
// DON'T DO THIS
const pythonPath = 'python3.12'; // Hard-coded
```

**✅ CORRECT** - Modify `shared/python-config.ts`:
```typescript
export function getPythonConfig(): PythonConfig {
  // Add your custom logic here
  if (process.platform === 'darwin') {
    const customPath = '/path/to/your/python';
    if (fs.existsSync(customPath)) {
      return {
        command: customPath,
        isConda: false,
        fullPath: customPath,
      };
    }
  }
  // ... rest of the logic
}
```

### To Use a Different Conda Environment

Edit the conda path in `shared/python-config.ts`:

```typescript
if (platform === 'darwin') {
  const condaEnvPath = '/opt/homebrew/Caskroom/miniconda/base/envs/YOUR_ENV_NAME/bin/python';
  // ...
}
```

## Required Python Packages

For Clippy to work properly, the configured Python must have:

### Required
- `whisper` (openai-whisper) - Audio transcription
- `requests` - HTTP communication

### Optional (for AI features)
- `openai` - OpenAI GPT support
- `anthropic` - Claude API support

### Installation

```bash
# Get the Python command being used
python_cmd=$(node -e "const {getPythonCommand} = require('./shared/python-config'); console.log(getPythonCommand())")

# Install packages
$python_cmd -m pip install openai-whisper requests openai anthropic
```

## Troubleshooting

### Issue: "No module named 'whisper'" at runtime

**Cause**: Whisper is installed for a different Python version than what's being used at runtime.

**Solution**:
1. Check which Python is being used: Run the app and look for logs showing "Using Python: ..."
2. Install packages for that specific Python:
   ```bash
   /path/to/that/python -m pip install openai-whisper requests
   ```

### Issue: Setup wizard finds Python but runtime doesn't

**Cause**: The wizard and runtime are using different Python versions.

**Solution**: Both should now use `shared/python-config.ts`. If this still happens, check:
1. Both files import from `shared/python-config`
2. The centralized config returns the same path consistently

### Issue: Different Python on different startups

**Cause**: The conda environment path exists sometimes but not others.

**Solution**: The config checks if the path exists before using it. Ensure the conda environment is always available or modify the config to skip the conda check.

## Best Practices

1. **Never hard-code Python commands** - Always use `getPythonCommand()`
2. **Verify installation** - Use `checkPythonPackages()` before runtime
3. **Log the Python path** - Help with debugging by logging which Python is being used
4. **Test after changes** - Any changes to python-config.ts should be tested across:
   - Setup wizard
   - Runtime transcription
   - Package installation

## System Architecture

```
┌─────────────────────────────────────────┐
│     shared/python-config.ts             │
│  (Single Source of Truth)               │
│                                         │
│  - getPythonCommand()                   │
│  - checkPythonPackages()                │
│  - validatePythonConfig()               │
└─────────────────────────────────────────┘
           ↓                ↓
           ↓                ↓
    ┌──────────┐    ┌─────────────┐
    │ Electron │    │   Backend   │
    │  Setup   │    │   Runtime   │
    │  Wizard  │    │   Service   │
    └──────────┘    └─────────────┘
         ↓                ↓
         ↓                ↓
    ┌─────────────────────────┐
    │   Same Python Process   │
    │   /opt/.../python       │
    └─────────────────────────┘
```

## Version History

- **v1.0** - Initial Python integration (had version mismatch issues)
- **v2.0** - Centralized Python configuration (current)
  - Created `shared/python-config.ts`
  - Updated `python-bridge.service.ts` to use centralized config
  - Updated `whisper-setup-wizard.ts` to use centralized config
  - Prevents version mismatch between setup and runtime
