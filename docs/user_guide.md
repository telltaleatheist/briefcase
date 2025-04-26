# Clippy User Guide

Welcome to Clippy, your all-in-one video downloader application. This guide will walk you through all the features and how to use them effectively.

## Getting Started

### Main Interface

The Clippy interface consists of several sections:

1. **Download Form** - Enter URLs and configure download options
2. **Download Progress** - View current download status
3. **Download History** - View and manage your previous downloads
4. **Settings** - Configure application preferences

### Downloading Your First Video

1. Paste a video URL into the input field (e.g., a YouTube link)
2. Select your preferred quality
3. Click the "Download" button
4. Watch the progress in the progress section
5. Once complete, the video will appear in your download history

## Features in Detail

### Supported Platforms

Clippy can download videos from a wide range of platforms, including:

- YouTube
- TikTok
- Twitter/X
- Reddit
- Vimeo
- Facebook
- Instagram
- Dailymotion
- And many more!

### Quality Options

Select your preferred quality from the dropdown:
- 360p - Low quality, small file size
- 480p - Standard quality
- 720p - HD quality (default)
- 1080p - Full HD quality
- 1440p - Quad HD quality
- 2160p - 4K quality

The application will attempt to download the best available quality that doesn't exceed your selection.

### Advanced Options

Click the "Advanced Options" panel to access additional settings:

#### Convert to MP4

When enabled (default), Clippy will convert downloaded videos to MP4 format for maximum compatibility with media players.

#### Fix Aspect Ratio

When enabled (default), Clippy will automatically fix the aspect ratio of videos that aren't 16:9, adding a blurred background to fill the frame without distorting the original video.

#### Use Browser Cookies

When enabled (default), Clippy will use cookies from your browser to access videos that might require login or have geographic restrictions.

#### Browser Selection

Choose which browser to use for cookies:
- Auto-detect (default)
- Google Chrome
- Mozilla Firefox
- Microsoft Edge
- Safari
- Brave Browser
- Opera

#### Output Directory

Specify where to save downloaded videos. If left empty, videos will be saved to the default downloads directory.

### Download History

The download history section shows all your previously downloaded videos. For each video, you can:

1. **Download** - Download the video again
2. **Play** - Stream the video in your browser
3. **Remove** - Remove the video from your history (doesn't delete the actual file)

Use the "Clear History" button to remove all items from your history.

### Settings

Access the settings page by clicking the gear icon in the top right corner:

#### Download Settings

Configure default values for:
- Default quality
- Convert to MP4
- Fix aspect ratio
- Use browser cookies
- Browser selection
- Default output directory

#### Appearance Settings

- Theme: Choose between Light, Dark, or Auto (follows system preference)

## Keyboard Shortcuts

- **Ctrl+V** or **Cmd+V** - Paste URL from clipboard
- **Enter** - Start download (when URL field is focused)
- **Escape** - Cancel current download

## Tips and Tricks

1. **URL Validation** - Clippy automatically validates URLs and shows video information when available

2. **Batch Downloads** - While Clippy processes one download at a time, you can queue multiple downloads by starting a new one after the current one completes

3. **Video Player** - The built-in streaming feature lets you preview videos without downloading them again

4. **File Naming** - Downloaded files are automatically named with the date and title of the video

5. **Cookie Access** - For videos that require login (like private YouTube videos), make sure to:
   - Log in to the service in your browser first
   - Enable "Use browser cookies" option
   - Select the correct browser

## Troubleshooting

### Common Issues

1. **Download Fails Immediately**
   - Check if the URL is correct
   - Try a different quality setting
   - Ensure the video isn't region-restricted

2. **Slow Downloads**
   - This is usually due to the source website's limitations
   - Try a lower quality setting

3. **Browser Cookies Not Working**
   - Make sure you're logged in to the service in the selected browser
   - Try selecting a different browser

4. **Video Playback Issues**
   - If the video doesn't play in the built-in player, try downloading it
   - Some video formats may require special codecs in your system

### Getting Help

If you encounter any issues not covered in this guide, please:
1. Check the [GitHub Issues page](https://github.com/yourusername/clippy/issues)
2. Create a new issue with detailed information about your problem

## Privacy and Security

Clippy respects your privacy:
- No data is sent to external servers except to download the videos you request
- Browser cookies are only accessed with your permission and only used for the video services you're downloading from
- No analytics or tracking is included in the application

## Legal Considerations

Please use Clippy responsibly:
- Only download videos that you have the right to download
- Respect copyright laws and terms of service for the platforms you're downloading from
- Some platforms prohibit downloading videos in their terms of service

## Updates

Clippy will check for updates automatically. When an update is available, you'll see a notification in the application.