# Clippy Verification Scripts

This directory contains scripts to verify and validate various aspects of the Clippy application.

## verify-python-setup.js

Comprehensive verification script for Python configuration.

### What It Checks

1. **Configuration Files** - Verifies all Python config files exist
2. **Python Detection** - Confirms Python is found at the configured path
3. **Python Validation** - Validates Python version and accessibility
4. **Package Availability** - Checks for whisper, requests, openai, anthropic
5. **Bridge Execution** - Tests actual Python script execution via the bridge

### Usage

```bash
# Run verification
node scripts/verify-python-setup.js

# Or use npm script (if defined)
npm run verify:python
```

### Expected Output

```
✓ ALL TESTS PASSED
  Python configuration is correct and consistent!
```

### If Tests Fail

1. **Config files missing**: Run `npm run build:electron && npm run build:backend`
2. **Python not found**: Check `backend/src/shared/python-config.ts` and verify the path exists
3. **Packages missing**: Install with: `[python-command] -m pip install openai-whisper requests openai anthropic`
4. **Bridge fails**: Check that `backend/python/video_analysis_service.py` exists

### Exit Codes

- `0` - All tests passed
- `1` - One or more tests failed

## Adding New Verification Scripts

When adding new scripts to this directory:

1. Make them executable: `chmod +x scripts/your-script.js`
2. Add shebang line: `#!/usr/bin/env node`
3. Document usage in this README
4. Use clear logging with emojis for readability
5. Exit with appropriate codes (0 = success, 1 = failure)
