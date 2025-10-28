# Model Connection Troubleshooting

## What Was Fixed

I've enhanced the model checking code with comprehensive logging. Now when you click "Check Model Availability", you'll see detailed logs that explain exactly what's happening.

## Updated Files

1. **backend/src/analysis/ollama.service.ts** - TypeScript service with step-by-step logging
2. **backend/python/video_analysis_service.py** - Python service with detailed diagnostics

## How to View the Logs

### Option 1: Electron DevTools Console
1. In the Clippy app, press `Cmd+Option+I` (Mac) or `Ctrl+Shift+I` (Windows/Linux)
2. Go to the Console tab
3. Click "Check Model Availability"
4. Look for messages starting with `[Model Check]`

### Option 2: Backend Logs
Check the backend logs at:
- macOS: `~/Library/Logs/clippy/backend.log`
- View with: `tail -f ~/Library/Logs/clippy/backend.log`

## What the Logs Tell You

The enhanced logging now shows:

```
[Model Check] Testing availability for: cogito:70b
[Model Check] Ollama endpoint: http://localhost:11434
[Model Check] Timeout: 300 seconds (5 minutes)
[Model Check] Step 1: Checking Ollama server connection...
[Model Check] ✓ Ollama server is reachable (HTTP 200)
[Model Check] Available models in Ollama: cogito:14b, cogito:70b, qwen2.5:7b, ...
[Model Check] ✓ Model "cogito:70b" found in Ollama model list
[Model Check] Step 2: Testing model response with generate request...
[Model Check] ✓ Model cogito:70b is available and responding (took 44.4s)
```

## Common Issues and Solutions

### Issue: Model loads but times out
**Symptom:** `Model loading timed out after 300s`
**Cause:** Model is extremely large or system is under heavy load
**Solution:**
- **Timeout is now 5 minutes** - should handle even cogito:70b (40GB model)
- If still timing out, try a smaller model like `qwen2.5:7b` (4GB, loads in ~3s)
- Or close other applications to free up RAM

### Issue: Model not found in list
**Symptom:** `Model not found in Ollama model list`
**Cause:** Model isn't installed
**Solution:** Run `ollama pull cogito:70b`

### Issue: Cannot connect to Ollama
**Symptom:** `Cannot connect to Ollama server`
**Cause:** Ollama isn't running
**Solution:** Start Ollama with `ollama serve`

### Issue: Wrong endpoint
**Symptom:** `Connection refused to Ollama at http://localhost:XXXX`
**Cause:** Wrong port configured
**Solution:** Check Advanced Options → Ollama Endpoint (should be `http://localhost:11434`)

## Test Results

I tested cogito:70b directly:
- ✓ Model exists in Ollama
- ✓ Model can load and respond
- ⏱️ Takes ~44 seconds to respond (19s load + 24s processing)

## Recommended Models

For faster performance:
- **qwen2.5:7b** - 4GB, ~3-5s response time
- **llama3.2:3b** - 2GB, ~2-3s response time
- **cogito:14b** - 9GB, ~8-12s response time

For best quality (requires patience):
- **cogito:70b** - 40GB, ~44s response time, requires 64GB+ RAM

## Next Steps

1. **Restart the Clippy app** to load the new logging code
2. Click "Check Model Availability"
3. Open DevTools Console to see the detailed logs
4. The logs will tell you exactly why it's failing

The new code now checks:
1. ✓ Can connect to Ollama server
2. ✓ Model exists in the model list
3. ✓ Model can actually load and respond (not just exist)

This matches ContentStudio's proven approach.
