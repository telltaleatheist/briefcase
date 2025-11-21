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
          <div class="media-container" [attr.data-media-id]="currentItem()?.id">
            @if (isVideo()) {
              <video
                #videoPlayer
                [src]="mediaSrc()"
                [attr.data-video-id]="currentItem()?.id"
                (loadedmetadata)="onVideoLoaded()"
                (canplay)="onCanPlay()"
                (timeupdate)="onTimeUpdate()"
                (ended)="onVideoEnded()"
                (error)="onMediaError($event)"
                (click)="togglePlay()"
                preload="metadata"
              >
                Your browser does not support the video tag.
              </video>
            } @else {
              <img
                #imageElement
                [src]="mediaSrc()"
                [attr.data-image-id]="currentItem()?.id"
                [alt]="currentItem()?.name || 'Preview'"
                (error)="onMediaError($event)"
                (load)="onImageLoaded()"
              />
            }
          </div>

          <div class="media-info">
            <div class="filename">{{ currentItem()?.name || 'No file selected' }}</div>
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
              <button class="control-btn play-btn" (click)="togglePlay()">
                {{ isPlaying() ? '⏸' : '▶' }}
              </button>
              <div class="progress-container" (click)="seek($event)">
                <div class="progress-bar">
                  <div class="progress-fill" [style.width.%]="progress()"></div>
                </div>
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

      video, img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      video {
        cursor: pointer;
      }
    }

    .media-info {
      margin-bottom: $spacing-sm;
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
      align-items: center;
      gap: $spacing-sm;
    }

    .control-btn {
      width: 36px;
      height: 36px;
      border-radius: $radius-full;
      background: var(--primary-orange);
      border: none;
      font-size: $font-size-base;
      color: white;
      cursor: pointer;
      transition: all $transition-fast;
      @include flex-center;
      flex-shrink: 0;

      &:hover {
        background: var(--primary-orange-dark);
        transform: scale(1.05);
      }

      &:active {
        transform: scale(0.95);
      }
    }

    .progress-container {
      flex: 1;
      cursor: pointer;
      padding: $spacing-xs 0;
    }

    .progress-bar {
      height: 4px;
      background: var(--bg-tertiary);
      border-radius: $radius-full;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--primary-orange), var(--primary-pink));
      border-radius: $radius-full;
      transition: width 0.1s ease-out;
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

  // Backend URL - fallback to localhost:3000 which is the default
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
      this.pendingAutoplay = true;
      this.needsCenter = true;
      // Try to get backend URL from Electron
      this.initBackendUrl();
      // Load the current media after a delay to ensure DOM is ready
      setTimeout(() => this.loadCurrentMedia(), 150);
    }
  }

  @Input() set previewItems(value: PreviewItem[]) {
    this.items.set(value);
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
  currentTime = signal(0);
  duration = signal(0);
  progress = signal(0);
  position = signal({ x: 100, y: 100 });
  windowSize = signal({ width: 480, height: 360 });

  private isDragging = false;
  private dragOffset = { x: 0, y: 0 };
  private isResizing = false;
  private resizeHandle: string | null = null;
  private resizeStart = { x: 0, y: 0, width: 0, height: 0, posX: 0, posY: 0 };
  private pendingAutoplay = false;
  private needsCenter = false;
  private readonly minWidth = 320;
  private readonly minHeight = 240;

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
    return `${this.backendUrl}/api/database/videos/${mediaId}/stream`;
  };

  private async initBackendUrl() {
    try {
      if ((window as any).electron?.getBackendUrl) {
        const url = await (window as any).electron.getBackendUrl();
        if (url) {
          this.backendUrl = url;
        }
      }
    } catch {
      // Use fallback
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
    // Reset playback state
    this.currentTime.set(0);
    this.progress.set(0);
    this.duration.set(0);
    this.isPlaying.set(false);

    const item = this.currentItem();
    if (!item) return;

    console.log('Loading media:', {
      name: item.name,
      isVideo: this.isVideo(),
      mediaType: item.mediaType,
      mediaSrc: this.mediaSrc()
    });

    // Angular's binding will automatically update the src attribute
    // We just need to ensure the video element reloads when it appears
    if (this.isVideo()) {
      // Check if video element exists after Angular renders it
      setTimeout(() => {
        if (this.videoPlayer?.nativeElement) {
          const video = this.videoPlayer.nativeElement;
          console.log('Video element found, loading...');
          video.load();
        } else {
          console.warn('Video element not found in DOM after timeout');
        }
      }, 50);
    }
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
        this.close();
        break;
      case ' ':
        // Space to toggle play (only for videos)
        event.preventDefault();
        if (this.isVideo()) {
          this.togglePlay();
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.previous();
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.next();
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

  onVideoLoaded() {
    if (this.videoPlayer?.nativeElement) {
      this.duration.set(this.videoPlayer.nativeElement.duration);
    }
  }

  onImageLoaded() {
    // Image loaded successfully - nothing special to do
    this.pendingAutoplay = false;
  }

  /**
   * Called when video has enough data to start playing
   */
  onCanPlay() {
    if (this.pendingAutoplay && this.isVideo() && this.videoPlayer?.nativeElement) {
      this.pendingAutoplay = false;
      const video = this.videoPlayer.nativeElement;
      console.log('Video can play, attempting autoplay...');
      video.play().then(() => {
        this.isPlaying.set(true);
        console.log('Autoplay successful');
      }).catch(err => {
        console.warn('Autoplay failed (browser may have blocked it):', err);
        // Autoplay might be blocked by browser, that's ok - user can click play
      });
    }
  }

  onTimeUpdate() {
    if (this.videoPlayer?.nativeElement) {
      const video = this.videoPlayer.nativeElement;
      this.currentTime.set(video.currentTime);
      this.progress.set((video.currentTime / video.duration) * 100 || 0);
    }
  }

  onVideoEnded() {
    this.isPlaying.set(false);
  }

  onMediaError(event: Event) {
    const target = event.target as HTMLVideoElement | HTMLImageElement;
    const item = this.currentItem();

    if (target instanceof HTMLVideoElement) {
      console.error('Video load error:', {
        name: item?.name,
        src: target.src,
        error: target.error?.message || 'Unknown error',
        mediaType: item?.mediaType
      });
    } else {
      console.error('Image load error:', {
        name: item?.name,
        src: (target as HTMLImageElement).src,
        mediaType: item?.mediaType
      });
    }
  }

  seek(event: MouseEvent) {
    if (!this.isVideo() || !this.videoPlayer?.nativeElement) return;

    const container = event.currentTarget as HTMLElement;
    const rect = container.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    this.videoPlayer.nativeElement.currentTime = percent * this.videoPlayer.nativeElement.duration;
  }

  formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds)) return '00:00';

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
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
