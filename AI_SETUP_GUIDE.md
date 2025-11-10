# AI Setup System - User Guide

## Overview

Clippy now features a comprehensive, user-friendly AI setup system that makes it clear that **AI features are completely optional**. Users can fully use the video library, player, and download features without any AI configuration.

## New Components

### 1. AI Setup Helper Service (`ai-setup-helper.service.ts`)

A service that automatically detects AI availability:
- Checks if Ollama is installed and running
- Detects available Ollama models
- Checks for Claude and OpenAI API keys
- Provides installation instructions based on user's platform
- Recommends models for first-time setup

**Key Features:**
- Auto-detection of Ollama on `http://localhost:11434`
- Platform-specific installation instructions (macOS, Windows, Linux)
- Recommended models with size and description
- Observable-based state management for reactive UI updates

### 2. AI Setup Tooltip Component (`ai-setup-tooltip`)

A fun, cartoonish tooltip component for displaying helpful messages:
- Animated pop-in effects
- Bouncing icons
- Multiple types: info, warning, success, setup
- Customizable actions and buttons
- Responsive design with dark mode support

**Usage Example:**
```html
<app-ai-setup-tooltip
  type="setup"
  title="AI Features Need Setup"
  message="Install Ollama or add an API key to use AI features"
  [showActionButton]="true"
  actionButtonText="Set Up Now"
  (action)="openSetup()">
</app-ai-setup-tooltip>
```

### 3. AI Setup Wizard (`ai-setup-wizard`)

A comprehensive step-by-step wizard for setting up AI:

**Steps:**
1. **Welcome** - Explains all three options with pros/cons:
   - Ollama (free, local, recommended)
   - Claude API (high quality, paid)
   - OpenAI API (fast, paid)

2. **Ollama Installation** (if selected):
   - Platform-specific instructions
   - Recommended models with size info
   - Copy-to-clipboard commands
   - Real-time availability checking
   - "Check if Ready" button

3. **API Keys Setup** (if selected):
   - Guided steps to get Claude/OpenAI keys
   - Links to provider websites
   - Secure password input fields
   - Validation and saving

4. **Done** - Success screen showing:
   - Active providers
   - Available models
   - Next steps

**Features:**
- Back navigation between steps
- Skip option on every screen
- Real-time Ollama detection
- Persistent API key storage
- Beautiful animations and gradients

### 4. First Time Welcome Dialog (`first-time-welcome`)

A welcoming onboarding dialog shown on first launch:

**Content:**
- Welcome message
- Feature showcase highlighting core features
- Clear "AI Features Optional" notice
- Two-button choice:
  - "Get Started" (skip AI setup)
  - "Set Up AI Features (Optional)"

**Key Message:**
> "You can use Clippy's library, player, and download features without any AI setup. AI features (transcription and analysis) require additional setup but are **not required** to use the core functionality."

### 5. Video Analysis Dialog Integration

The video analysis dialog now includes:

**AI Setup Banner:**
- Appears when user tries to use AI features without setup
- Prominent but dismissible banner at top of dialog
- Animated bouncing robot icon
- Context-aware messages based on selected mode
- "Set Up AI" button that opens the wizard
- Dismiss button for later setup

**Smart Detection:**
- Only shows for modes that need AI (transcribe-only, full)
- Doesn't show for import-only mode
- Automatically refreshes after AI setup completion
- Reloads available models after setup

## User Flow

### First-Time User
1. Opens Clippy for the first time
2. Sees "Welcome to Clippy" dialog
3. Reads that AI is optional
4. Chooses to either:
   - Get started immediately (skip AI)
   - Set up AI features now

### Using AI Features Without Setup
1. User tries to analyze or transcribe a video
2. Video analysis dialog opens
3. AI setup banner appears with friendly message
4. User can:
   - Click "Set Up AI" to open wizard
   - Dismiss and try again later
   - Switch to import-only mode (no AI needed)

### Setting Up Ollama
1. Click "Set Up AI" from anywhere
2. Wizard opens, showing all options
3. User selects "Ollama"
4. Sees platform-specific instructions
5. Downloads Ollama from website
6. Copies and runs model pull command
7. Clicks "Check if Ready"
8. System detects Ollama and models
9. Success screen confirms setup

### Setting Up API Keys
1. Click "Set Up AI"
2. Select "Claude API" or "ChatGPT API"
3. Opens wizard with API key instructions
4. Links to provider websites
5. User creates/copies API key
6. Pastes key into secure field
7. Wizard validates and saves key
8. Success screen confirms setup

## Messages for Users

### For Dummies - Key Explanations

**What is Ollama?**
- Free AI that runs on your computer
- No internet needed after download
- Privacy-focused (data stays local)
- One-time 4GB+ download
- Recommended for most users

**What is Claude/ChatGPT API?**
- AI services you pay per use
- High quality results
- No installation needed
- Costs ~$0.01-0.05 per video
- Good if you don't want to download large files

**What is transcription?**
- Converts speech in videos to text
- Useful for searching video content
- Can work without AI (basic mode)
- AI makes it more accurate

**What is analysis?**
- AI reads transcript and summarizes video
- Extracts topics and people mentioned
- Creates smart tags for search
- Requires either Ollama or API key

### Friendly Messages Throughout

- "Good news! AI features are completely optional."
- "You don't need to use AI features to use the rest of the system, but access will be limited"
- "Install Ollama for free local AI, or add an API key for Claude/ChatGPT"
- "Come back here and we'll detect it automatically!"
- "You can always set up AI features later from the settings menu"

## Technical Details

### Platform Detection
Automatically detects user's OS and provides correct instructions:
- **macOS**: DMG installation
- **Windows**: EXE installer
- **Linux**: curl installation script

### Model Recommendations
Default recommendations for Ollama:
1. `qwen2.5:7b` - 4GB (balanced, recommended)
2. `llama3.2:3b` - 2GB (lightweight, fast)
3. `qwen2.5:14b` - 9GB (high quality)

### API Key Storage
- Stored in backend at `~/Library/Application Support/clippy/api-keys.json`
- Masked when displayed in UI
- Secure HTTP-only communication
- Separate storage from Electron settings

### Automatic Detection
The system checks:
1. Ollama running on `http://localhost:11434`
2. Available models via `/api/tags` endpoint
3. Model responsiveness with test generation
4. Existing API keys from config file

### State Management
- RxJS BehaviorSubject for reactive updates
- Availability state cached with timestamps
- Real-time updates when checking/saving
- Observable pattern for component subscriptions

## Future Enhancements

Potential improvements:
- [ ] Automatic Ollama installation helper
- [ ] Model download progress tracking
- [ ] Cost calculator for API usage
- [ ] Model comparison chart
- [ ] In-app Ollama controls (start/stop/update)
- [ ] Backup API key option
- [ ] Multi-provider fallback
- [ ] Custom Ollama endpoint configuration
- [ ] Model performance benchmarks

## Developer Notes

### Adding New Providers
To add a new AI provider:

1. Update `AIAvailability` interface in `ai-setup-helper.service.ts`
2. Add detection method (e.g., `checkNewProvider()`)
3. Update `checkAIAvailability()` to include new check
4. Add option card in wizard welcome step
5. Create provider-specific setup step if needed
6. Update backend `ai-provider.service.ts`

### Testing Checklist
- [ ] First-time user sees welcome dialog
- [ ] AI setup prompt appears when needed
- [ ] Ollama detection works correctly
- [ ] API key validation and saving
- [ ] Platform detection is accurate
- [ ] Copy-to-clipboard functionality
- [ ] Back/skip navigation works
- [ ] Success screen shows correct info
- [ ] Dialog reopens properly after setup
- [ ] Models refresh after Ollama setup

### Styling Notes
All components support:
- Light and dark mode
- Responsive design (mobile-friendly)
- Smooth animations
- Accessibility (ARIA labels, tooltips)
- Material Design integration

## Conclusion

The new AI setup system makes Clippy approachable for all users, whether they're tech-savvy or complete beginners. By making AI optional and providing clear, step-by-step guidance, users can choose their preferred experience without feeling overwhelmed or forced into complex setup processes.
