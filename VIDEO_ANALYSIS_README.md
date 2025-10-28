# Video Analysis Feature

## Overview

The Video Analysis feature uses AI to automatically analyze video content, identify interesting sections, and extract key quotes with timestamps. It combines:
- **Whisper** for fast audio transcription
- **Ollama** for AI-powered content analysis
- **Streaming results** for real-time progress updates

## Prerequisites

### 1. Python Dependencies

Install the required Python packages:

```bash
cd backend/python
pip install -r requirements.txt
```

This installs:
- `openai-whisper` - For audio transcription
- `requests` - For Ollama API communication

### 2. Ollama Setup

1. **Install Ollama**: Download from [https://ollama.ai](https://ollama.ai)

2. **Pull an AI Model**: Choose based on your system resources

```bash
# Lightweight (recommended for most users)
ollama pull llama3.2:3b

# Balanced performance and quality
ollama pull qwen2.5:7b

# Best quality (requires ~40GB RAM)
ollama pull cogito:70b
```

3. **Verify Ollama is running**:
```bash
curl http://localhost:11434/api/tags
```

## Usage

### From the UI

1. Navigate to the **Video Analysis** tab
2. Choose input type:
   - **URL**: Enter a YouTube or other video URL
   - **File**: Select a local video file
3. Configure settings:
   - **AI Model**: Choose your installed model
   - **Whisper Model**: Faster models = lower accuracy but quicker processing
   - **Language**: Set to match video language or use "auto-detect"
4. Click **Check Model Availability** to verify your AI model is installed
5. Click **Start Analysis**

### Progress Phases

The analysis runs through several phases:

1. **Download (0-20%)**: Downloads video (if URL provided) - uses low quality for speed
2. **Extract Audio (20-30%)**: Extracts audio track from video
3. **Transcribe (30-60%)**: Converts speech to text using Whisper
4. **Analyze (60-95%)**: AI analyzes transcript to find interesting sections
5. **Finalize (95-100%)**: Writes final report

### Output Files

Results are saved to `~/Downloads/clippy/analysis/` by default:

```
~/Downloads/clippy/
├── videos/           # Downloaded videos (if from URL)
└── analysis/
    ├── transcripts/  # Full transcripts (.srt and .txt)
    └── reports/      # Analysis reports with timestamped quotes
```

## Configuration

### Speed Priority Settings

The feature is optimized for speed over quality:

**Video Download**:
- Quality: 360p (lowest)
- Format: Original (no conversion)
- Processing: Minimal

**Transcription**:
- Default model: `base` (good balance)
- Use `tiny` for maximum speed
- Use `small` or `medium` only if accuracy is critical

**AI Analysis**:
- Beam size: 1 (faster decoding)
- Temperature: 0 (deterministic output)
- Chunk size: 15 minutes with 3-minute overlap

### Customization

You can modify settings in:
- **Frontend**: `video-analysis.component.ts`
- **Backend**: `analysis.service.ts`
- **Python**: `video_analysis_service.py`

## API Endpoints

### Start Analysis
```
POST /api/analysis/start
{
  "input": "https://youtube.com/watch?v=...",
  "inputType": "url",
  "aiModel": "qwen2.5:7b",
  "ollamaEndpoint": "http://localhost:11434",
  "whisperModel": "base",
  "language": "en"
}
```

### Check Model Availability
```
POST /api/analysis/check-model
{
  "model": "qwen2.5:7b",
  "endpoint": "http://localhost:11434"
}
```

### Get Job Status
```
GET /api/analysis/job/:jobId
```

### List Available Models
```
GET /api/analysis/models
```

## WebSocket Events

Real-time progress updates via Socket.IO:

```javascript
socket.on('analysisProgress', (data) => {
  console.log(data.progress);    // 0-100
  console.log(data.currentPhase); // Description
  console.log(data.status);      // pending, transcribing, analyzing, etc.
});
```

## Troubleshooting

### "Cannot connect to Ollama"
- Ensure Ollama is running: `ollama serve`
- Check endpoint: `http://localhost:11434`
- Verify firewall settings

### "Model not available"
- Install model: `ollama pull <model-name>`
- Check model list: `ollama list`
- Verify model name matches exactly

### "Whisper not installed"
- Install Python package: `pip install openai-whisper`
- May require additional dependencies (ffmpeg, etc.)
- Check Python version: Python 3.8+

### Slow Performance
- Use smaller models (`llama3.2:3b` instead of `cogito:70b`)
- Use `tiny` Whisper model instead of `base`
- Reduce video length or quality
- Ensure sufficient RAM available

### Analysis Finds No Interesting Sections
- Video may lack controversial/notable content
- Try adjusting the analysis criteria in Python script
- Check transcript quality - poor audio = poor results

## Architecture

```
┌─────────────┐
│   Angular   │
│  Component  │
└──────┬──────┘
       │
       ├─HTTP──────────┐
       │               │
       └─WebSocket─────┤
                       │
            ┌──────────▼──────────┐
            │   NestJS Backend    │
            │  Analysis Service   │
            └──────────┬──────────┘
                       │
            ┌──────────┴──────────┐
            │                     │
     ┌──────▼──────┐       ┌─────▼────┐
     │   Python    │       │  Ollama  │
     │   Whisper   │       │    AI    │
     └─────────────┘       └──────────┘
```

## Performance Tips

1. **First-time setup**: Download Whisper model ahead of time (happens automatically on first use)
2. **Local files**: Using local files skips download phase (saves 0-20%)
3. **Batch processing**: Queue multiple videos to process sequentially
4. **Model selection**: Start with smaller models, upgrade only if results are poor

## Future Enhancements

- [ ] Support for multiple languages simultaneously
- [ ] Custom analysis categories/filters
- [ ] Export to various formats (JSON, CSV, Markdown)
- [ ] Integration with video player for jump-to-timestamp
- [ ] Batch analysis queue
- [ ] Sentiment analysis
- [ ] Speaker identification
- [ ] Topic clustering

## Credits

Built with:
- [OpenAI Whisper](https://github.com/openai/whisper)
- [Ollama](https://ollama.ai)
- [NestJS](https://nestjs.com)
- [Angular Material](https://material.angular.io)
