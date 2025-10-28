# Filename Test Examples

## Test Cases

| Original Video Filename | Transcript | Report | Notes |
|------------------------|------------|--------|-------|
| `2025-10-25 shane vaughn.mp4` | `2025-10-25 shane vaughn.srt`<br>`2025-10-25 shane vaughn.txt` | `2025-10-25 shane vaughn.txt` | ✅ Preserves case & spaces |
| `The Joe Rogan Experience #2050.mp4` | `The Joe Rogan Experience #2050.srt`<br>`The Joe Rogan Experience #2050.txt` | `The Joe Rogan Experience #2050.txt` | ✅ Preserves # symbol |
| `Interview: CEO's Vision for 2024.mp4` | `Interview_ CEO's Vision for 2024.srt`<br>`Interview_ CEO's Vision for 2024.txt` | `Interview_ CEO's Vision for 2024.txt` | ⚠️  `:` replaced with `_` |
| `My Video/Tutorial.mp4` | `My Video_Tutorial.srt`<br>`My Video_Tutorial.txt` | `My Video_Tutorial.txt` | ⚠️  `/` replaced with `_` |
| `Video<Test>.mp4` | `Video_Test_.srt`<br>`Video_Test_.txt` | `Video_Test_.txt` | ⚠️  `<>` replaced with `_` |

## Invalid Characters Replaced

These characters are **NOT allowed** in filenames on most filesystems:
- `<` `>` `:` `"` `/` `\` `|` `?` `*` 
- Control chars (0x00-0x1F)

They will be replaced with `_` (underscore).

## Examples of Preserved Characters

These are **allowed** and will be kept as-is:
- Spaces: `My Video.mp4` → `My Video.txt` ✅
- Hyphens: `2025-10-25.mp4` → `2025-10-25.txt` ✅
- Underscores: `my_video.mp4` → `my_video.txt` ✅
- Periods: `v1.0.mp4` → `v1.0.txt` ✅
- Numbers: `Episode 123.mp4` → `Episode 123.txt` ✅
- Special: `#@!$%^&()[]{}+=.mp4` → `#@!$%^&()[]{}+=.txt` ✅
