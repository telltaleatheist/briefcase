# Model Keep-Alive Testing Guide

## What Was Implemented

Added intelligent model keep-alive functionality to improve queue processing efficiency by ensuring Ollama keeps models loaded in memory between jobs:

### Features

1. **Model Preloading**: Before each analysis job, the system checks if the required model is already loaded in memory
2. **Keep-Alive Timer**: Loaded models stay in memory for 5 minutes after last use
3. **Smart Model Switching**: When switching to a different model, the system automatically unloads the previous model to free memory
4. **Automatic Cleanup**: Models are automatically unloaded after 5 minutes of inactivity

### How It Works

When processing a queue of analysis jobs:

1. **First Job**: Model is loaded (may take 30-60 seconds for large models)
2. **Subsequent Jobs (same model)**: Model is already loaded, analysis starts immediately
3. **Model Switch**: If queue has jobs with different models, old model is unloaded before new one loads
4. **Idle Timeout**: After 5 minutes of no jobs, model is automatically unloaded to free memory

### Expected Performance Improvement

- **Same Model Jobs**: ~35% faster (eliminates model loading time between jobs)
- **Example**: Processing 8 videos with same model
  - Before: ~8 minutes (60s model load per job)
  - After: ~5 minutes (model loaded once, kept alive)

## Testing Steps

### Test 1: Basic Keep-Alive (Same Model)

1. Open Clippy application
2. Go to Video Analysis page
3. Add 3-4 videos to the processing queue using the same AI model (e.g., qwen2.5:7b)
4. Start processing
5. **Watch the logs** - you should see:
   - First job: `[Keep-Alive] Preloading model: qwen2.5:7b`
   - Subsequent jobs: `[Keep-Alive] Model qwen2.5:7b already loaded, keep-alive refreshed`
   - After each job: `Model qwen2.5:7b will stay loaded for 5 minutes`

### Test 2: Model Switching

1. Add videos with different models to the queue:
   - Video 1: qwen2.5:7b
   - Video 2: qwen2.5:7b
   - Video 3: llama3.2:3b
   - Video 4: llama3.2:3b
2. Start processing
3. **Watch the logs** - you should see:
   - Jobs 1-2: Use qwen2.5:7b (second job reuses loaded model)
   - Job 3: Unload qwen2.5:7b, load llama3.2:3b
   - Job 4: Reuse llama3.2:3b

### Test 3: Idle Timeout

1. Process a single video
2. Wait and watch the logs
3. After 5 minutes of inactivity, you should see:
   - `[Keep-Alive] Model <name> idle timeout reached, unloading...`
   - `[Keep-Alive] Model <name> unloaded successfully`

## Log Messages to Look For

### Success Indicators

- ✅ `[Keep-Alive] Preloading model: <model>` - First time loading
- ✅ `[Keep-Alive] Model <model> preloaded successfully`
- ✅ `[Keep-Alive] Model <model> already loaded, keep-alive refreshed` - Reusing loaded model
- ✅ `[Keep-Alive] Unloading N other model(s) to make room for <model>` - Switching models
- ✅ `Model <model> will stay loaded for 5 minutes` - After analysis completes

### Potential Issues

- ⚠️ `Failed to prepare model <model>: <error>. Continuing anyway...` - Model prep failed but analysis will still attempt
- ⚠️ `Failed to unload idle model <model>: <error>` - Cleanup failed (non-critical)

## Files Modified

- [backend/src/analysis/ollama.service.ts](backend/src/analysis/ollama.service.ts) - Added keep-alive tracking, preload, unload, and prepareModel methods with `keep_alive: '5m'` parameter
- [backend/src/analysis/analysis.service.ts](backend/src/analysis/analysis.service.ts:487-494) - Integrated model preparation before analysis phase
- [backend/python/video_analysis_service.py](backend/python/video_analysis_service.py:1060) - Added `keep_alive: "5m"` parameter to Ollama API calls in `call_ollama()` and `check_ollama_model()` functions

## Critical Fix

The key fix was adding the `keep_alive` parameter to **all** Ollama API calls:
- In TypeScript: `keep_alive: '5m'`
- In Python: `keep_alive: "5m"`

Without this parameter, Ollama unloads models immediately after each request, defeating the purpose of the keep-alive system. With this parameter, Ollama keeps models in memory for 5 minutes after the last request, allowing subsequent jobs to reuse the loaded model.

## Configuration

The keep-alive duration is currently set to 5 minutes. To change it, modify:

```typescript
// backend/src/analysis/ollama.service.ts:22
private readonly KEEP_ALIVE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
```

## How to Verify It's Working

### Before Keep-Alive
Processing 3 videos with same model would show model loading logs 3 times, taking longer.

### After Keep-Alive
Processing 3 videos with same model shows:
1. First video: Model loads once
2. Second video: "Model already loaded" message, starts immediately
3. Third video: "Model already loaded" message, starts immediately
4. After 5 minutes: Model auto-unloads

The time between "Analysis started" and actual analysis beginning should be much shorter for jobs 2-3.
