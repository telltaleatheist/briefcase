import { Component, EventEmitter, Input, Output, signal, ViewChild, ElementRef, HostListener, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface PreviewItem {
  id: string;
  name: string;
  videoId?: string; // Database video ID for streaming
  mediaType?: string; // e.g., 'video/mp4', 'image/jpeg'
}

@Component({
  selector: 'app-video-preview-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (visible() && currentItem()) {
      <div class="floating-window"
           [style.left.px]="position().x"
           [style.top.px]="position().y"
           [style.width.px]="windowSize().width"
           [style.height.px]="windowSize().height"
           #floatingWindow>
        <div class="window-header"
             (mousedown)="startDrag($event)"
             (dblclick)="isVideo() && togglePlay()">
          <span class="position-indicator">{{ currentIndex() + 1 }} / {{ items().length }}</span>
          <button class="window-close" (click)="close()">×</button>
        </div>

        <div class="window-body">
          <div class="media-container" [attr.data-media-id]="currentItem().id">
            @if (hasError()) {
              <div class="error-overlay">
                <div class="error-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                </div>
                <div class="error-message">{{ mediaError() }}</div>
                <div class="error-details">{{ currentItem().name }}</div>
              </div>
            } @else if (isVideo()) {
              <video
                #videoPlayer
                [src]="mediaSrc()"
                (loadedmetadata)="onVideoLoaded()"
                (loadeddata)="onVideoLoadedData()"
                (durationchange)="onDurationChange()"
                (canplay)="onCanPlay()"
                (canplaythrough)="onCanPlayThrough()"
                (playing)="onPlaying()"
                (timeupdate)="onTimeUpdate()"
                (ended)="onVideoEnded()"
                (error)="onMediaError($event)"
                playsinline
              ></video>
            } @else {
              <img
                #imageElement
                [src]="mediaSrc()"
                [attr.data-image-id]="currentItem().id"
                [alt]="currentItem().name || 'Preview'"
                (error)="onMediaError($event)"
                (load)="onImageLoaded()"
              />
            }
          </div>

          <div class="media-info">
            <div class="filename">{{ currentItem().name || 'No file selected' }}</div>
            @if (isVideo()) {
              <div class="time-display">
                {{ formatTime(currentTime()) }} / {{ formatTime(duration()) }}
              </div>
            } @else {
              <div class="time-display">Image</div>
            }
          </div>

          @if (isVideo()) {
            <div class="controls">
              <div class="progress-container"
                   (mousedown)="onProgressMouseDown($event)"
                   title="Click or drag to seek">
                <div class="progress-bar">
                  <div class="progress-fill" [style.width.%]="progress()"></div>
                  <div class="progress-handle" [style.left.%]="progress()"></div>
                </div>
              </div>
              <div class="controls-row">
                <button class="control-btn" (click)="skipTime(-10)" title="Skip backward 10s (J)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12.5 8L7.5 12l5 4V8z"/>
                    <path d="M18.5 8L13.5 12l5 4V8z"/>
                  </svg>
                </button>
                <button class="control-btn play-btn" (click)="togglePlay()" title="Play/Pause (Space or K)">
                  @if (isPlaying()) {
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="5" width="4" height="14" rx="1"/>
                      <rect x="14" y="5" width="4" height="14" rx="1"/>
                    </svg>
                  } @else {
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5.5v13l10-6.5L8 5.5z"/>
                    </svg>
                  }
                </button>
                <button class="control-btn" (click)="skipTime(10)" title="Skip forward 10s (L)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11.5 8l5 4-5 4V8z"/>
                    <path d="M5.5 8l5 4-5 4V8z"/>
                  </svg>
                </button>
              </div>
            </div>
          }
        </div>

        <!-- Resize handles -->
        <div class="resize-handle resize-right" (mousedown)="startResize($event, 'right')"></div>
        <div class="resize-handle resize-bottom" (mousedown)="startResize($event, 'bottom')"></div>
        <div class="resize-handle resize-bottom-right" (mousedown)="startResize($event, 'bottom-right')"></div>
        <div class="resize-handle resize-left" (mousedown)="startResize($event, 'left')"></div>
        <div class="resize-handle resize-top" (mousedown)="startResize($event, 'top')"></div>
        <div class="resize-handle resize-top-left" (mousedown)="startResize($event, 'top-left')"></div>
        <div class="resize-handle resize-top-right" (mousedown)="startResize($event, 'top-right')"></div>
        <div class="resize-handle resize-bottom-left" (mousedown)="startResize($event, 'bottom-left')"></div>
      </div>
    }
  `,
  styles: [`
    @use '../../../styles/variables' as *;
    @use '../../../styles/mixins' as *;

    .floating-window {
      position: fixed;
      background: var(--bg-card);
      border-radius: $radius-lg;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
      overflow: hidden;
      z-index: $z-modal;
      animation: fadeIn 0.2s ease-out;
      border: 2px solid var(--border-color);
      display: flex;
      flex-direction: column;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }

    .window-header {
      @include flex-between;
      padding: $spacing-sm $spacing-md;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      cursor: move;
      user-select: none;

      &:active {
        cursor: grabbing;
      }
    }

    .window-close {
      width: 24px;
      height: 24px;
      border-radius: $radius-full;
      background: transparent;
      border: none;
      font-size: $font-size-lg;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all $transition-fast;
      @include flex-center;

      &:hover {
        background: var(--bg-tertiary);
        color: var(--error);
      }
    }

    .position-indicator {
      font-size: $font-size-xs;
      color: var(--text-secondary);
      font-weight: $font-weight-medium;
    }

    .window-body {
      padding: $spacing-md;
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .media-container {
      background: #000;
      border-radius: $radius-md;
      overflow: hidden;
      margin-bottom: $spacing-sm;
      flex: 1;
      min-height: 0;
      @include flex-center;
      position: relative;

      video, img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

    }


    .error-overlay {
      @include flex-center;
      flex-direction: column;
      width: 100%;
      height: 100%;
      padding: $spacing-lg;
      text-align: center;
      gap: $spacing-md;
    }

    .error-icon {
      color: var(--error);
      opacity: 0.8;

      svg {
        width: 64px;
        height: 64px;
      }
    }

    .error-message {
      font-size: 1rem;
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
    }

    .error-details {
      font-size: $font-size-sm;
      color: var(--text-secondary);
      word-break: break-all;
      max-width: 100%;
    }

    .media-info {
      margin-bottom: $spacing-sm;
      flex-shrink: 0;
    }

    .filename {
      font-size: $font-size-sm;
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
      margin-bottom: $spacing-xs;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .time-display {
      font-size: $font-size-xs;
      color: var(--text-secondary);
      font-family: 'Monaco', monospace;
    }

    .controls {
      display: flex;
      flex-direction: column;
      gap: $spacing-sm;
      flex-shrink: 0;
    }

    .controls-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: $spacing-md;
    }

    .control-btn {
      width: 32px;
      height: 32px;
      border-radius: $radius-full;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all $transition-fast;
      @include flex-center;
      flex-shrink: 0;
      padding: 0;

      svg {
        width: 18px;
        height: 18px;
      }

      &:hover {
        color: $primary-orange;
        transform: scale(1.1);
      }

      &:active {
        transform: scale(0.95);
      }

      &.play-btn {
        width: 40px;
        height: 40px;
        background: $gradient-sunset;
        color: white;
        box-shadow: 0 2px 8px rgba(255, 107, 53, 0.3);

        svg {
          width: 20px;
          height: 20px;
        }

        &:hover {
          transform: scale(1.1);
          box-shadow: 0 4px 12px rgba(255, 107, 53, 0.4);
        }
      }
    }

    .progress-container {
      width: 100%;
      cursor: pointer;
      padding: $spacing-sm 0;

      &:hover .progress-handle {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }
    }

    .progress-bar {
      height: 4px;
      background: var(--bg-tertiary);
      border-radius: $radius-full;
      position: relative;
    }

    .progress-fill {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      background: $gradient-sunset;
      border-radius: $radius-full;
      pointer-events: none;
    }

    .progress-handle {
      position: absolute;
      top: 50%;
      width: 12px;
      height: 12px;
      background: $primary-orange;
      border-radius: $radius-full;
      transform: translate(-50%, -50%) scale(0);
      opacity: 0;
      transition: all $transition-fast;
      pointer-events: none;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
    }

    /* Resize handles */
    .resize-handle {
      position: absolute;
      z-index: 10;

      &.resize-right {
        right: 0;
        top: 0;
        bottom: 0;
        width: 8px;
        cursor: ew-resize;
      }

      &.resize-left {
        left: 0;
        top: 0;
        bottom: 0;
        width: 8px;
        cursor: ew-resize;
      }

      &.resize-bottom {
        left: 0;
        right: 0;
        bottom: 0;
        height: 8px;
        cursor: ns-resize;
      }

      &.resize-top {
        left: 0;
        right: 0;
        top: 0;
        height: 8px;
        cursor: ns-resize;
      }

      &.resize-bottom-right {
        right: 0;
        bottom: 0;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
      }

      &.resize-bottom-left {
        left: 0;
        bottom: 0;
        width: 16px;
        height: 16px;
        cursor: nesw-resize;
      }

      &.resize-top-right {
        right: 0;
        top: 0;
        width: 16px;
        height: 16px;
        cursor: nesw-resize;
      }

      &.resize-top-left {
        left: 0;
        top: 0;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
      }
    }
  `]
})
export class VideoPreviewModalComponent implements AfterViewChecked {
  @ViewChild('videoPlayer') videoPlayer!: ElementRef<HTMLVideoElement>;
  @ViewChild('imageElement') imageElement!: ElementRef<HTMLImageElement>;
  @ViewChild('floatingWindow') floatingWindow!: ElementRef<HTMLDivElement>;

  // Backend URL - fallback to localhost:3000 which is the backend default
  private backendUrl = 'http://localhost:3000';

  // Image extensions for detection
  private readonly imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif'];

  @Input() set show(value: boolean) {
    const wasVisible = this.visible();
    this.visible.set(value);

    if (value && !wasVisible) {
      // Opening modal - reset state
      this.currentTime.set(0);
      this.progress.set(0);
      this.duration.set(0);
      this.isPlaying.set(false);
      this.pendingAutoplay = true;
      this.needsCenter = true;
      // Initialize backend URL first, then load media
      this.initBackendUrl().then(() => {
        // Load the current media after a delay to ensure DOM is ready
        setTimeout(() => this.loadCurrentMedia(), 100);
      });
    } else if (!value) {
      // Modal closing - pause video if playing
      if (this.videoPlayer?.nativeElement) {
        this.videoPlayer.nativeElement.pause();
      }
      this.isPlaying.set(false);
    }
  }

  @Input() set previewItems(value: PreviewItem[]) {
    this.items.set(value);
  }

  // Refresh key - increment to force reload of current video (e.g., after path update)
  @Input() set refreshKey(value: number) {
    const prevKey = this.internalRefreshKey();
    if (prevKey !== value && prevKey !== 0) {
      // Key changed (and not initial load), force reload current media
      console.log('Refresh key changed, reloading current media');
      this.internalRefreshKey.set(value);
      if (this.visible()) {
        this.loadCurrentMedia();
      }
    } else {
      this.internalRefreshKey.set(value);
    }
  }

  @Input() set selectedId(value: string | undefined) {
    if (!value) return;
    const items = this.items();
    const idx = items.findIndex(item => item.id === value);
    if (idx >= 0) {
      const previousIndex = this.currentIndex();
      this.currentIndex.set(idx);

      // Only reload if the index actually changed OR if modal just opened
      if (previousIndex !== idx || !this.visible()) {
        this.pendingAutoplay = true;
        console.log('Selection changed, setting pendingAutoplay=true');
        // Give Angular time to render the new element
        setTimeout(() => this.loadCurrentMedia(), 100);
      }
    }
  }

  @Output() closed = new EventEmitter<void>();
  @Output() selectionChanged = new EventEmitter<string>();

  visible = signal(false);
  items = signal<PreviewItem[]>([]);
  currentIndex = signal(0);
  isPlaying = signal(false);
  internalRefreshKey = signal(0);
  currentTime = signal(0);
  duration = signal(0);
  progress = signal(0);
  position = signal({ x: 100, y: 100 });
  windowSize = signal({ width: 640, height: 480 });
  volume = signal(1.0); // 0.0 to 1.0
  isMuted = signal(false);
  playbackRate = signal(1.0); // Playback speed
  mediaError = signal<string | null>(null); // Track media loading errors
  hasError = signal(false); // Track if current media has an error

  // Progress bar scrubbing state
  private isScrubbingProgress = false;
  private scrubProgressContainer: HTMLElement | null = null;
  private wasPlayingBeforeScrub = false;
  private scrubAnimationFrame: number | null = null;
  private pendingSeekPercent: number | null = null;

  private isDragging = false;
  private dragOffset = { x: 0, y: 0 };
  private isResizing = false;
  private resizeHandle: string | null = null;
  private resizeStart = { x: 0, y: 0, width: 0, height: 0, posX: 0, posY: 0 };
  private pendingAutoplay = false;
  private needsCenter = false;
  private readonly minWidth = 400;
  private readonly minHeight = 320;

  currentItem = () => this.items()[this.currentIndex()];

  /**
   * Check if the current item is a video (not an image)
   */
  isVideo = (): boolean => {
    const item = this.currentItem();
    if (!item) {
      return true; // Default to video
    }

    // Check mediaType first
    if (item.mediaType) {
      // Handle both "video/mp4" and "video" formats
      const result = item.mediaType.startsWith('video/') || item.mediaType === 'video';
      return result;
    }

    // Fall back to checking file extension
    const name = item.name.toLowerCase();
    const hasImageExt = this.imageExtensions.some(ext => name.endsWith(ext));
    return !hasImageExt;
  };

  mediaSrc = () => {
    const item = this.currentItem();
    if (!item) return '';

    // Use videoId if available for streaming from backend
    const mediaId = item.videoId || item.id;
    let url = `${this.backendUrl}/api/database/videos/${mediaId}/stream`;

    // Add cache-busting parameter if refresh key is set (video was re-processed)
    const refreshKey = this.internalRefreshKey();
    if (refreshKey > 0) {
      url += `?t=${refreshKey}`;
    }

    console.log('Media source URL:', {
      url,
      mediaId,
      itemId: item.id,
      itemVideoId: item.videoId,
      itemName: item.name,
      refreshKey
    });

    return url;
  };

  private async initBackendUrl() {
    try {
      if ((window as any).electron?.getBackendUrl) {
        const url = await (window as any).electron.getBackendUrl();
        if (url) {
          this.backendUrl = url;
          console.log('Backend URL initialized:', this.backendUrl);
        } else {
          console.log('Using fallback backend URL:', this.backendUrl);
        }
      } else {
        console.log('Electron API not available, using fallback backend URL:', this.backendUrl);
      }
    } catch (error) {
      console.warn('Failed to get backend URL, using fallback:', this.backendUrl, error);
    }
  }

  ngAfterViewChecked() {
    // Center window after it's rendered
    if (this.needsCenter && this.floatingWindow?.nativeElement) {
      this.needsCenter = false;
      setTimeout(() => this.centerWindow(), 0);
    }
  }

  private loadCurrentMedia() {
    // Reset playback state and error state
    this.currentTime.set(0);
    this.progress.set(0);
    this.duration.set(0);
    this.isPlaying.set(false);
    this.hasError.set(false);
    this.mediaError.set(null);

    const item = this.currentItem();
    if (!item) return;

    console.log('Loading media:', {
      name: item.name,
      isVideo: this.isVideo(),
      mediaType: item.mediaType,
      mediaSrc: this.mediaSrc(),
      pendingAutoplay: this.pendingAutoplay
    });

    // For videos, Angular's [src] binding handles loading automatically
    // We just need to ensure autoplay happens once the video is ready
    // No need to call video.load() which can cause race conditions
  }

  /**
   * Navigate to next item in list
   */
  next(): void {
    const items = this.items();
    if (items.length === 0) return;

    const newIndex = (this.currentIndex() + 1) % items.length;
    this.currentIndex.set(newIndex);
    this.pendingAutoplay = true;
    this.loadCurrentMedia();
    this.selectionChanged.emit(items[newIndex].id);
  }

  /**
   * Navigate to previous item in list
   */
  previous(): void {
    const items = this.items();
    if (items.length === 0) return;

    const newIndex = this.currentIndex() === 0 ? items.length - 1 : this.currentIndex() - 1;
    this.currentIndex.set(newIndex);
    this.pendingAutoplay = true;
    this.loadCurrentMedia();
    this.selectionChanged.emit(items[newIndex].id);
  }

  /**
   * Handle keyboard events for navigation
   */
  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    if (!this.visible()) return;

    // Don't handle if user is typing in an input
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopImmediatePropagation(); // Prevent other components from handling
        this.close();
        break;
      case ' ':
        // Space to toggle play (only for videos)
        event.preventDefault();
        event.stopImmediatePropagation(); // Prevent cascade from handling (spacebar opens preview there)
        if (this.isVideo()) {
          this.togglePlay();
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopImmediatePropagation(); // Prevent cascade from also handling
        this.previous();
        break;
      case 'ArrowDown':
        event.preventDefault();
        event.stopImmediatePropagation(); // Prevent cascade from also handling
        this.next();
        break;
      case 'ArrowLeft':
        // Seek backward 5 seconds
        event.preventDefault();
        if (this.isVideo()) {
          this.skipTime(-5);
        }
        break;
      case 'ArrowRight':
        // Seek forward 5 seconds
        event.preventDefault();
        if (this.isVideo()) {
          this.skipTime(5);
        }
        break;
      case 'j':
      case 'J':
        // Seek backward 10 seconds
        event.preventDefault();
        if (this.isVideo()) {
          this.skipTime(-10);
        }
        break;
      case 'l':
      case 'L':
        // Seek forward 10 seconds
        event.preventDefault();
        if (this.isVideo()) {
          this.skipTime(10);
        }
        break;
      case 'k':
      case 'K':
        // Toggle play/pause (alternative to space)
        event.preventDefault();
        if (this.isVideo()) {
          this.togglePlay();
        }
        break;
      case 'm':
      case 'M':
        // Toggle mute
        event.preventDefault();
        if (this.isVideo()) {
          this.toggleMute();
        }
        break;
      case ',':
        // Frame by frame backward
        event.preventDefault();
        if (this.isVideo()) {
          this.frameStep(-1);
        }
        break;
      case '.':
        // Frame by frame forward
        event.preventDefault();
        if (this.isVideo()) {
          this.frameStep(1);
        }
        break;
    }
  }

  centerWindow() {
    if (!this.floatingWindow?.nativeElement) return;
    const windowWidth = this.floatingWindow.nativeElement.offsetWidth;
    const windowHeight = this.floatingWindow.nativeElement.offsetHeight;
    const x = (window.innerWidth - windowWidth) / 2;
    const y = (window.innerHeight - windowHeight) / 2;
    this.position.set({ x: Math.max(0, x), y: Math.max(0, y) });
  }

  startDrag(event: MouseEvent) {
    if (event.button !== 0) return; // Only left click
    event.preventDefault();

    this.isDragging = true;
    const pos = this.position();
    this.dragOffset = {
      x: event.clientX - pos.x,
      y: event.clientY - pos.y
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isDragging) return;
      const newX = e.clientX - this.dragOffset.x;
      const newY = e.clientY - this.dragOffset.y;
      this.position.set({ x: newX, y: newY });
    };

    const onMouseUp = () => {
      this.isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  startResize(event: MouseEvent, handle: string) {
    if (event.button !== 0) return; // Only left click
    event.preventDefault();
    event.stopPropagation(); // Prevent dragging

    this.isResizing = true;
    this.resizeHandle = handle;

    const pos = this.position();
    const size = this.windowSize();
    this.resizeStart = {
      x: event.clientX,
      y: event.clientY,
      width: size.width,
      height: size.height,
      posX: pos.x,
      posY: pos.y
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isResizing || !this.resizeHandle) return;

      const deltaX = e.clientX - this.resizeStart.x;
      const deltaY = e.clientY - this.resizeStart.y;

      let newWidth = this.resizeStart.width;
      let newHeight = this.resizeStart.height;
      let newX = this.resizeStart.posX;
      let newY = this.resizeStart.posY;

      // Handle horizontal resize
      if (this.resizeHandle.includes('right')) {
        newWidth = Math.max(this.minWidth, this.resizeStart.width + deltaX);
      } else if (this.resizeHandle.includes('left')) {
        const proposedWidth = this.resizeStart.width - deltaX;
        if (proposedWidth >= this.minWidth) {
          newWidth = proposedWidth;
          newX = this.resizeStart.posX + deltaX;
        }
      }

      // Handle vertical resize
      if (this.resizeHandle.includes('bottom')) {
        newHeight = Math.max(this.minHeight, this.resizeStart.height + deltaY);
      } else if (this.resizeHandle.includes('top')) {
        const proposedHeight = this.resizeStart.height - deltaY;
        if (proposedHeight >= this.minHeight) {
          newHeight = proposedHeight;
          newY = this.resizeStart.posY + deltaY;
        }
      }

      this.windowSize.set({ width: newWidth, height: newHeight });
      this.position.set({ x: newX, y: newY });
    };

    const onMouseUp = () => {
      this.isResizing = false;
      this.resizeHandle = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  togglePlay() {
    if (!this.isVideo() || !this.videoPlayer?.nativeElement) return;

    const video = this.videoPlayer.nativeElement;
    if (video.paused) {
      video.play().then(() => {
        this.isPlaying.set(true);
      }).catch(err => {
        console.error('Failed to play video:', err);
      });
    } else {
      video.pause();
      this.isPlaying.set(false);
    }
  }

  skipTime(seconds: number) {
    if (!this.videoPlayer?.nativeElement) return;
    const video = this.videoPlayer.nativeElement;
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
  }

  toggleMute() {
    if (!this.videoPlayer?.nativeElement) return;
    const video = this.videoPlayer.nativeElement;
    video.muted = !video.muted;
    this.isMuted.set(video.muted);
  }

  frameStep(direction: number) {
    if (!this.videoPlayer?.nativeElement) return;
    const video = this.videoPlayer.nativeElement;
    video.pause();
    this.isPlaying.set(false);
    // Assuming 30fps, 1 frame = 1/30 second
    video.currentTime += (direction / 30);
  }

  setVolume(value: number) {
    if (!this.videoPlayer?.nativeElement) return;
    const video = this.videoPlayer.nativeElement;
    const clampedValue = Math.max(0, Math.min(1, value));
    video.volume = clampedValue;
    this.volume.set(clampedValue);
    // If setting volume above 0, unmute
    if (clampedValue > 0 && video.muted) {
      video.muted = false;
      this.isMuted.set(false);
    }
  }

  setPlaybackRate(rate: number) {
    if (!this.videoPlayer?.nativeElement) return;
    const video = this.videoPlayer.nativeElement;
    video.playbackRate = rate;
    this.playbackRate.set(rate);
  }


  onImageLoaded() {
    // Image loaded successfully - nothing special to do
    this.pendingAutoplay = false;
  }

  onVideoLoaded() {
    if (this.videoPlayer?.nativeElement) {
      const video = this.videoPlayer.nativeElement;

      // Only set duration if it's a valid number
      if (!isNaN(video.duration) && isFinite(video.duration) && video.duration > 0) {
        this.duration.set(video.duration);
      }

      // Initialize video properties from signals
      video.volume = this.volume();
      video.muted = this.isMuted();
      video.playbackRate = this.playbackRate();

      // Try autoplay as soon as metadata is loaded
      this.tryAutoplay();
    }
  }

  onDurationChange() {
    if (this.videoPlayer?.nativeElement) {
      const video = this.videoPlayer.nativeElement;
      // Duration may become available after initial metadata load (common with streaming)
      if (!isNaN(video.duration) && isFinite(video.duration) && video.duration > 0) {
        this.duration.set(video.duration);
      }
    }
  }

  onVideoLoadedData() {
    this.tryAutoplay();
  }

  onCanPlay() {
    this.tryAutoplay();
  }

  onCanPlayThrough() {
    // This fires when enough data is buffered to play to the end
    this.tryAutoplay();
  }

  private tryAutoplay() {
    if (!this.pendingAutoplay || !this.isVideo() || !this.videoPlayer?.nativeElement) {
      return;
    }

    const video = this.videoPlayer.nativeElement;

    // Check if video is ready enough to play
    // readyState: 0=HAVE_NOTHING, 1=HAVE_METADATA, 2=HAVE_CURRENT_DATA, 3=HAVE_FUTURE_DATA, 4=HAVE_ENOUGH_DATA
    if (video.readyState < 2) {
      console.log('Video not ready yet, readyState:', video.readyState);
      return; // Wait for more data
    }

    console.log('Attempting autoplay, readyState:', video.readyState);

    // Electron has no autoplay restrictions - just play
    video.play().then(() => {
      console.log('Autoplay succeeded');
      this.pendingAutoplay = false;
      this.isPlaying.set(true);
    }).catch(err => {
      console.error('Autoplay failed:', err);
      // Don't clear pendingAutoplay on failure - we might retry
    });
  }

  onPlaying() {
    this.isPlaying.set(true);
    this.pendingAutoplay = false;
  }

  onTimeUpdate() {
    if (this.videoPlayer?.nativeElement) {
      const video = this.videoPlayer.nativeElement;
      this.currentTime.set(video.currentTime);

      const videoDuration = video.duration;
      if (videoDuration && !isNaN(videoDuration) && isFinite(videoDuration) && videoDuration > 0) {
        // Update duration if not already set (can become available during playback)
        if (this.duration() === 0) {
          this.duration.set(videoDuration);
        }
        this.progress.set((video.currentTime / videoDuration) * 100);
      } else {
        this.progress.set(0);
      }
    }
  }

  onVideoEnded() {
    this.isPlaying.set(false);
  }

  /**
   * Handle progress bar mousedown - start scrubbing with drag support
   */
  onProgressMouseDown(event: MouseEvent) {
    if (event.button !== 0) return; // Only left click
    if (!this.videoPlayer?.nativeElement) return;

    event.preventDefault();

    const video = this.videoPlayer.nativeElement;
    const container = event.currentTarget as HTMLElement;

    this.isScrubbingProgress = true;
    this.scrubProgressContainer = container;
    this.wasPlayingBeforeScrub = !video.paused;

    // Pause while scrubbing for smoother experience
    if (this.wasPlayingBeforeScrub) {
      video.pause();
    }

    // Seek to clicked position immediately
    this.seekToPositionImmediate(event.clientX, container);

    // Set up document listeners for drag
    const onMouseMove = (e: MouseEvent) => {
      if (!this.isScrubbingProgress || !this.scrubProgressContainer) return;
      this.queueSeek(e.clientX, this.scrubProgressContainer);
    };

    const onMouseUp = () => {
      this.isScrubbingProgress = false;
      this.scrubProgressContainer = null;

      // Cancel any pending animation frame
      if (this.scrubAnimationFrame) {
        cancelAnimationFrame(this.scrubAnimationFrame);
        this.scrubAnimationFrame = null;
      }

      // Apply any pending seek
      if (this.pendingSeekPercent !== null && this.videoPlayer?.nativeElement) {
        const video = this.videoPlayer.nativeElement;
        video.currentTime = this.pendingSeekPercent * video.duration;
        this.pendingSeekPercent = null;
      }

      // Resume playback if was playing before scrub
      if (this.wasPlayingBeforeScrub && this.videoPlayer?.nativeElement) {
        this.videoPlayer.nativeElement.play().catch(() => {});
        this.isPlaying.set(true);
      }

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  /**
   * Queue a seek operation using requestAnimationFrame for smooth scrubbing
   */
  private queueSeek(clientX: number, container: HTMLElement) {
    const rect = container.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

    // Store the pending seek percent
    this.pendingSeekPercent = percent;

    // Update the visual progress immediately for responsiveness
    this.progress.set(percent * 100);

    // Only schedule a new animation frame if one isn't already pending
    if (!this.scrubAnimationFrame) {
      this.scrubAnimationFrame = requestAnimationFrame(() => {
        this.scrubAnimationFrame = null;

        if (this.pendingSeekPercent !== null && this.videoPlayer?.nativeElement) {
          const video = this.videoPlayer.nativeElement;
          video.currentTime = this.pendingSeekPercent * video.duration;
          this.currentTime.set(video.currentTime);
        }
      });
    }
  }

  /**
   * Seek immediately (for initial click)
   */
  private seekToPositionImmediate(clientX: number, container: HTMLElement) {
    if (!this.videoPlayer?.nativeElement) return;

    const video = this.videoPlayer.nativeElement;
    const rect = container.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    video.currentTime = percent * video.duration;
    this.progress.set(percent * 100);
    this.currentTime.set(video.currentTime);
  }

  onMediaError(event: Event) {
    const target = event.target as HTMLVideoElement | HTMLImageElement;
    const item = this.currentItem();

    // Set error state
    this.hasError.set(true);
    this.isPlaying.set(false);
    this.pendingAutoplay = false;

    let errorMessage = 'Failed to load media';

    if (target instanceof HTMLVideoElement) {
      const videoError = target.error;

      // Provide specific error messages based on error code
      if (videoError) {
        switch (videoError.code) {
          case MediaError.MEDIA_ERR_ABORTED:
            errorMessage = 'Video loading was aborted';
            break;
          case MediaError.MEDIA_ERR_NETWORK:
            errorMessage = 'Network error while loading video';
            break;
          case MediaError.MEDIA_ERR_DECODE:
            errorMessage = 'Video file is corrupted or in an unsupported format';
            break;
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorMessage = 'Video file not found or format not supported';
            break;
          default:
            errorMessage = videoError.message || 'Unknown video error';
        }
      }

      // Log detailed error for debugging
      console.error('Video load error:', {
        name: item?.name,
        src: target.src,
        error: errorMessage,
        errorCode: videoError?.code,
        mediaType: item?.mediaType
      });
    } else {
      errorMessage = 'Failed to load image';
      console.error('Image load error:', {
        name: item?.name,
        src: (target as HTMLImageElement).src,
        mediaType: item?.mediaType
      });
    }

    this.mediaError.set(errorMessage);
  }

  formatTime(seconds: number): string {
    // Only return placeholder for truly invalid values (NaN, Infinity, negative)
    if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return '00:00:00';

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  close() {
    if (this.videoPlayer?.nativeElement) {
      this.videoPlayer.nativeElement.pause();
    }
    this.visible.set(false);
    this.isPlaying.set(false);
    this.closed.emit();
  }
}
