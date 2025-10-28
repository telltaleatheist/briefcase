# File Naming Convention

## Overview
All analysis outputs (transcripts and reports) now use the **same base filename** as the source video, preserving the original case and spaces.

## Naming Examples

### Input Video
```
2025-10-25 shane vaughn.mp4
```

### Output Files
```
transcripts/
  ├── 2025-10-25 shane vaughn.srt     # Subtitle format with timestamps
  └── 2025-10-25 shane vaughn.txt     # Plain text transcript

reports/
  └── 2025-10-25 shane vaughn.txt     # AI analysis report
```

### Another Example
```
Input:  The Joe Rogan Experience #2050.mp4

Outputs:
  transcripts/The Joe Rogan Experience #2050.srt
  transcripts/The Joe Rogan Experience #2050.txt
  reports/The Joe Rogan Experience #2050.txt
```

## Sanitization Rules

The filename sanitization **preserves**:
- ✅ Original case (Shane, not shane)
- ✅ Spaces (not converted to underscores)
- ✅ Numbers, letters, hyphens, periods
- ✅ Special chars: `#`, `@`, `!`, etc.

The filename sanitization **removes/replaces**:
- ❌ Invalid filesystem chars: `< > : " / \ | ? *`
- ❌ Control characters (0x00-0x1F)
- ❌ Multiple consecutive underscores → single underscore
- ❌ Trailing dots or underscores
- ⚠️  Truncates to 200 chars if too long

## Code Location

The sanitization logic is in:
[backend/src/analysis/analysis.service.ts:346-369](backend/src/analysis/analysis.service.ts#L346-L369)

## Benefits

1. **Easy to find** - All related files have the same name
2. **Readable** - Preserves original formatting  
3. **Organized** - Group by prefix (e.g., all "2025-10-25" files together)
4. **Safe** - Removes only truly invalid characters

## Directory Structure

```
~/Downloads/clippy/
├── videos/
│   └── 2025-10-25 shane vaughn.mp4
├── analysis/
│   ├── transcripts/
│   │   ├── 2025-10-25 shane vaughn.srt
│   │   └── 2025-10-25 shane vaughn.txt
│   └── reports/
│       └── 2025-10-25 shane vaughn.txt
```

All files are grouped by the video's base name, making it easy to find related files.
