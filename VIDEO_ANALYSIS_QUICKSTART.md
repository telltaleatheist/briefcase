# Video Analysis - Quick Start Guide

## 🚀 Setup (One-time)

### 1. Install Python Dependencies

```bash
cd /Volumes/Callisto/Projects/clippy/backend/python
pip install -r requirements.txt
```

This installs:
- `openai-whisper` - Audio transcription
- `requests` - API communication

### 2. Install & Configure Ollama

```bash
# Install Ollama from https://ollama.ai
# Then pull a model (choose one based on your RAM):

# Fast & Lightweight (2GB RAM) - Recommended for testing
ollama pull llama3.2:3b

# Balanced (4GB RAM) - Good for general use
ollama pull qwen2.5:7b

# Best Quality (40GB RAM) - Your preferred model
ollama pull cogito:70b
```

### 3. Start Ollama Server

```bash
ollama serve
```

Keep this running in a terminal window.

## 🎬 Using Video Analysis

### From the Clippy UI

1. **Launch Clippy** (npm run dev or launch the app)
2. **Navigate** to "Video Analysis" tab (brain icon)
3. **Choose Input**:
   - **URL**: Paste a YouTube link
   - **File**: Browse to a local video file
4. **Check Model**: Click "Check Model Availability"
   - If unavailable, follow the installation instructions shown
5. **Start Analysis**: Click "Start Analysis"
6. **Watch Progress**: See real-time phase updates
7. **View Results**: Open the analysis report when complete

### Example URLs to Test

Good test videos (5-15 minutes recommended):
- YouTube tech talks
- News segments
- Podcast clips
- Educational content

**Avoid for first test**:
- Very long videos (>1 hour)
- Music videos (no speech content)
- Videos without speech

## 📊 What to Expect

### Processing Time

For a 10-minute video:
- **Download**: 30 seconds - 2 minutes
- **Audio Extract**: 10-30 seconds
- **Transcribe**: 2-5 minutes (base model)
- **AI Analysis**: 3-10 minutes (depends on model)
- **Total**: ~6-18 minutes

### Output Location

```
~/Downloads/clippy/analysis/
├── transcripts/
│   ├── video_title.srt     # Subtitles
│   └── video_title.txt     # Plain text
└── reports/
    └── video_title_analysis.txt  # AI analysis
```

### What Gets Analyzed

The AI looks for:
- Controversial statements
- Strong opinions/debates
- Important factual claims
- Emotional moments
- Key arguments

Each section includes:
- Timestamp range
- Category (controversy, claim, argument, etc.)
- Description
- 3-5 key quotes with timestamps

## ⚡ Speed Tips

1. **Use Smaller Models**: Start with `llama3.2:3b`, upgrade only if needed
2. **Local Files**: Skip download phase by using files already on disk
3. **Shorter Videos**: Test with 5-10 minute clips first
4. **Whisper Tiny**: Change to "tiny" model in advanced settings for 2x speed

## 🐛 Troubleshooting

### "Cannot connect to Ollama"
```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# If not, start it
ollama serve
```

### "Model not available"
```bash
# List installed models
ollama list

# Install missing model
ollama pull qwen2.5:7b
```

### "Whisper not installed"
```bash
# Reinstall Python dependencies
cd backend/python
pip install --upgrade openai-whisper
```

### Analysis finds nothing interesting
- Try a video with debates, opinions, or factual claims
- News, tech talks, and podcasts work best
- Music videos and silent content won't have interesting sections

## 🔧 Advanced Configuration

### Change Default Output Path

In the UI: Advanced Options → Output Path
Or edit: `~/Downloads/clippy/analysis/` (default)

### Adjust Analysis Criteria

Edit: `backend/python/video_analysis_service.py`
- Modify the prompt in `identify_interesting_sections()`
- Add custom categories
- Adjust chunk size and overlap

### Use Different Ollama Endpoint

If running Ollama on another machine:
- Advanced Options → Ollama Endpoint
- Enter: `http://your-server:11434`

## 📝 Notes

- First transcription downloads Whisper model (~150MB for base)
- GPU acceleration not currently enabled (CPU-only)
- Analysis quality depends heavily on AI model size
- Transcript quality affects analysis quality

## 🎯 Next Steps

After successful first test:
- Try different AI models
- Experiment with longer videos
- Adjust Whisper model for accuracy vs speed
- Compare results across different content types

## 📖 Full Documentation

See [VIDEO_ANALYSIS_README.md](VIDEO_ANALYSIS_README.md) for:
- Complete API documentation
- Architecture details
- WebSocket events
- Customization guide
