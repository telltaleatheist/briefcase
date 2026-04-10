import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { WebArchiveService, WebArchiveItem } from '../../services/web-archive.service';
import { ElectronService } from '../../services/electron.service';
import { NotificationService } from '../../services/notification.service';
import { LibraryService } from '../../services/library.service';
import { QueueService } from '../../services/queue.service';
import { AiSetupService } from '../../services/ai-setup.service';
import { WebsocketService } from '../../services/websocket.service';
import { createQueueTask } from '../../models/queue-job.model';
import { CascadeComponent } from '../cascade/cascade.component';
import { VideoItem, VideoWeek } from '../../models/video.model';

@Component({
  selector: 'app-archives-tab',
  standalone: true,
  imports: [CommonModule, FormsModule, CascadeComponent],
  templateUrl: './archives-tab.component.html',
  styleUrls: ['./archives-tab.component.scss']
})
export class ArchivesTabComponent implements OnInit, OnDestroy {
  private webArchiveService = inject(WebArchiveService);
  private electronService = inject(ElectronService);
  private notificationService = inject(NotificationService);
  private libraryService = inject(LibraryService);
  private queueService = inject(QueueService);
  private aiSetupService = inject(AiSetupService);
  private webSocketService = inject(WebsocketService);
  private http = inject(HttpClient);

  private unsubscribeAnalysisCompleted?: () => void;

  urlInput = signal('');
  isLoading = signal(false);
  selectedItems = signal<Set<string>>(new Set());

  // Map archives into VideoWeek format grouped by domain
  archiveWeeks = computed(() => {
    const archives = this.webArchiveService.archives();
    if (archives.length === 0) return [];

    // Group by domain
    const grouped = new Map<string, WebArchiveItem[]>();
    for (const archive of archives) {
      const domain = archive.domain || 'Unknown';
      if (!grouped.has(domain)) {
        grouped.set(domain, []);
      }
      grouped.get(domain)!.push(archive);
    }

    // Convert to VideoWeek format, sorted alphabetically by domain
    const weeks: VideoWeek[] = [];
    const sortedDomains = Array.from(grouped.keys()).sort();

    for (const domain of sortedDomains) {
      const items = grouped.get(domain)!;
      // Sort items within domain by date descending
      items.sort((a, b) => (b.capture_date || '').localeCompare(a.capture_date || ''));

      const videos: VideoItem[] = items.map(item => this.archiveToVideoItem(item));
      const count = items.length;

      weeks.push({
        weekLabel: `${domain} (${count})`,
        videos,
      });
    }

    return weeks;
  });

  captureInProgress = this.webArchiveService.captureInProgress;

  ngOnInit() {
    this.loadData();

    // Auto-refresh archives when AI analysis completes for a webpage item
    // so the newly-generated suggested title appears without requiring a reload.
    this.unsubscribeAnalysisCompleted = this.webSocketService.onAnalysisCompleted((event) => {
      const archives = this.webArchiveService.archives();
      const isWebpageArchive = archives.some(a => a.video_id === event.videoId);
      if (isWebpageArchive) {
        this.webArchiveService.loadArchives();
      }
    });
  }

  ngOnDestroy() {
    if (this.unsubscribeAnalysisCompleted) {
      this.unsubscribeAnalysisCompleted();
    }
  }

  async loadData() {
    this.isLoading.set(true);
    try {
      await this.webArchiveService.refresh();
    } finally {
      this.isLoading.set(false);
    }
  }

  async onUrlSubmit() {
    const url = this.urlInput().trim();
    if (!url || !url.startsWith('http')) return;

    this.urlInput.set('');
    const result = await this.webArchiveService.captureUrl(url);

    if (result.success) {
      this.notificationService.success('Archived', 'Page archived successfully');
    } else {
      this.notificationService.error('Archive Failed', result.error || 'Unknown error');
    }
  }

  onSelectionChanged(selection: { ids: Set<string> }) {
    this.selectedItems.set(selection.ids);
  }

  async onVideoAction(event: { action: string; videos: VideoItem[] }) {
    const { action, videos } = event;
    const video = videos[0];
    if (!video) return;

    switch (action) {
      case 'open':
      case 'open-in-browser':
      case 'openInEditor':
        if (video.filePath) {
          await this.electronService.openInBrowser(video.filePath);
        }
        break;

      case 'copy-url':
        if (video.sourceUrl) {
          await navigator.clipboard.writeText(video.sourceUrl);
          this.notificationService.success('Copied', 'URL copied to clipboard');
        }
        break;

      case 'show-in-finder':
        if (video.filePath) {
          await this.electronService.showInFolder(video.filePath);
        }
        break;

      case 'delete':
        if (video.id) {
          try {
            await firstValueFrom(this.libraryService.deleteVideo(video.id));
            this.notificationService.success('Deleted', 'Archive deleted');
            await this.loadData();
          } catch (error) {
            this.notificationService.error('Delete Failed', 'Failed to delete archive');
          }
        }
        break;

      case 'analyzeWebpage':
        await this.analyzeWebpages(videos);
        break;
    }
  }

  /**
   * Queue webpage items for AI title generation.
   * Uses the user's configured default AI model.
   */
  private async analyzeWebpages(videos: VideoItem[]) {
    const webpages = videos.filter(v => v.mediaType === 'webpage');
    if (webpages.length === 0) return;

    const setupStatus = this.aiSetupService.getSetupStatus();
    if (setupStatus.needsSetup) {
      this.notificationService.error(
        'AI Not Configured',
        'Please set up an AI provider first.'
      );
      return;
    }

    // Resolve default AI model (library-specific first, then global)
    const API_BASE = 'http://localhost:3000/api';
    let defaultModel: string | null = null;
    try {
      const libResponse = await firstValueFrom(
        this.http.get<{ success: boolean; aiModel: string | null }>(
          `${API_BASE}/database/libraries/default-ai-model`
        )
      );
      defaultModel = libResponse?.aiModel || null;
    } catch (error) {
      console.error('Failed to fetch library default AI model:', error);
    }

    if (!defaultModel) {
      try {
        const configResponse = await firstValueFrom(
          this.http.get<{ success: boolean; defaultAI: { provider: string; model: string } | null }>(
            `${API_BASE}/config/default-ai`
          )
        );
        if (configResponse?.defaultAI) {
          defaultModel = `${configResponse.defaultAI.provider}:${configResponse.defaultAI.model}`;
        }
      } catch (error) {
        console.error('Failed to fetch global default AI model:', error);
      }
    }

    if (!defaultModel) {
      this.notificationService.error(
        'No AI Model Configured',
        'Please select a default AI model in Settings first.'
      );
      return;
    }

    for (const webpage of webpages) {
      const task = createQueueTask('analyze-webpage', { aiModel: defaultModel });
      this.queueService.addJob({
        videoId: webpage.id,
        title: webpage.name,
        thumbnail: webpage.thumbnailUrl,
        tasks: [task],
        titleResolved: true
      });
    }

    this.notificationService.success(
      'Queued',
      `${webpages.length} webpage${webpages.length > 1 ? 's' : ''} queued for AI title generation`
    );
  }

  async onBackfill() {
    this.isLoading.set(true);
    try {
      const result = await this.webArchiveService.backfillExisting();
      this.notificationService.success(
        'Backfill Complete',
        `Backfilled ${result.backfilled} of ${result.total} archives`
      );
      await this.loadData();
    } catch (error) {
      this.notificationService.error('Backfill Failed', 'Failed to backfill archives');
    } finally {
      this.isLoading.set(false);
    }
  }

  private archiveToVideoItem(item: WebArchiveItem): VideoItem {
    return {
      id: item.video_id,
      name: item.filename,
      suggestedTitle: item.suggested_title || item.page_title || undefined,
      // uploadDate = when the content was published/created online (parsed from
      // filename). downloadDate = when ClipChimp saved it locally.
      uploadDate: item.upload_date ? new Date(item.upload_date) : undefined,
      downloadDate: item.download_date ? new Date(item.download_date) : undefined,
      // Leave thumbnailUrl undefined so the cascade renders the uniform 🌐
      // placeholder for every web archive (easy to identify at a glance).
      thumbnailUrl: undefined,
      filePath: item.current_path,
      sourceUrl: item.original_url || undefined,
      mediaType: 'webpage',
      fileExtension: '.mhtml',
      size: item.file_size_bytes,
    };
  }
}
