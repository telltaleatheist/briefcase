import { Component, OnInit, Input, inject, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { forkJoin } from 'rxjs';
import {
  VideoInfo,
  VideoTag,
  AIAnalysis,
  TranscriptionSegment,
  TranscriptionSearchResult
} from '../../models/video-info.model';
import { VideoItem, VideoWeek } from '../../models/video.model';
import { LibraryService } from '../../services/library.service';
import { CascadeComponent } from '../cascade/cascade.component';

@Component({
  selector: 'app-video-info-page',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule, ScrollingModule, CascadeComponent],
  templateUrl: './video-info-page.component.html',
  styleUrls: ['./video-info-page.component.scss']
})
export class VideoInfoPageComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private libraryService = inject(LibraryService);
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);

  @Input() videoId?: string;

  // Loading state
  loading = true;
  error: string | null = null;

  videoInfo: VideoInfo | null = null;

  // Tag Management
  isAddingTag = false;
  newTagName = '';
  newTagCategory: VideoTag['category'] = 'custom';
  suggestedTags: string[] = ['Tutorial', 'Interview', 'Product Demo', 'Webinar', 'Educational'];

  // Description Editing
  isEditingDescription = false;
  editedDescription = '';

  // Date Editing
  isEditingDates = false;
  editedUploadDate = '';
  editedDownloadDate = '';

  // AI Analysis
  selectedAnalysis: AIAnalysis | null = null;
  analysisFilter: AIAnalysis['type'] | 'all' = 'all';

  // Transcription
  transcriptionSearchQuery = '';
  transcriptionSearchResults: TranscriptionSearchResult[] = [];
  highlightedSegmentId: string | null = null;
  showTimestamps = true;
  transcriptionView: 'continuous' | 'segments' = 'continuous';
  playbackPosition = 0; // Current video position in seconds

  // Children Management
  childVideos: any[] = [];
  parentVideos: any[] = [];
  isAddingChildren = false;
  showVideoSelector = false;
  availableVideos: VideoItem[] = [];
  availableVideosWeek: VideoWeek[] = [];
  selectedVideosForLink: Set<string> = new Set();
  videoSearchQuery = '';

  @ViewChild('videoSelectorCascade') videoSelectorCascade?: CascadeComponent;

  // UI State
  activeTab: 'overview' | 'metadata' | 'ai-analysis' | 'transcription' = 'overview';
  expandedSections = {
    tags: true,
    description: true,
    children: true,
    metadata: false,
    analyses: true,
    transcription: true
  };

  ngOnInit(): void {
    // Get video ID from route params or input
    const routeId = this.route.snapshot.paramMap.get('id');
    const id = this.videoId || routeId;

    if (!id) {
      this.error = 'No video ID provided';
      this.loading = false;
      return;
    }

    this.loadVideoInfo(id);
  }

  goBack(): void {
    this.router.navigate(['/library']);
  }

  getVideoStreamUrl(): string {
    const id = this.videoId || this.route.snapshot.paramMap.get('id');
    if (!id) return '';
    return `http://localhost:3000/api/database/videos/${id}/stream`;
  }

  private loadVideoInfo(videoId: string): void {
    this.loading = true;
    this.error = null;

    // Fetch all video data in parallel
    forkJoin({
      video: this.libraryService.getVideo(videoId),
      transcript: this.libraryService.getVideoTranscript(videoId),
      analysis: this.libraryService.getVideoAnalysis(videoId),
      tags: this.libraryService.getVideoTags(videoId),
      sections: this.libraryService.getVideoSections(videoId)
    }).subscribe({
      next: (results) => {
        if (!results.video.success || !results.video.data) {
          this.error = 'Video not found';
          this.loading = false;
          return;
        }

        const video = results.video.data;
        const transcript = results.transcript.data;
        const analysis = results.analysis.data;
        const tags = results.tags.data || [];
        const sections = results.sections.data || [];

        // Transform backend data to VideoInfo format
        this.videoInfo = this.transformToVideoInfo(video, transcript, analysis, tags, sections);

        // Auto-expand the first analysis by default
        if (this.videoInfo.aiAnalyses.length > 0) {
          this.selectedAnalysis = this.videoInfo.aiAnalyses[0];
        }

        // Load children
        this.loadChildren(videoId);

        this.loading = false;
      },
      error: (err) => {
        console.error('Failed to load video info:', err);
        this.error = 'Failed to load video information';
        this.loading = false;
      }
    });
  }

  private transformToVideoInfo(
    video: any,
    transcript: any,
    analysis: any,
    tags: string[],
    sections: any[]
  ): VideoInfo {
    // Parse duration from various formats
    const parseDuration = (duration: string | number): number => {
      if (typeof duration === 'number') return duration;
      if (!duration) return 0;

      // Handle hh:mm:ss or mm:ss format
      const parts = duration.split(':').map(p => parseInt(p, 10));
      if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
      } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
      }
      return parseInt(duration, 10) || 0;
    };

    // Transform tags to VideoTag format
    // Backend returns TagRecord[] with tag_name, tag_type, etc.
    const videoTags: VideoTag[] = tags.map((tag: any, index: number) => ({
      id: tag.id || `tag-${index}`,
      name: tag.tag_name || tag,
      category: (tag.tag_type || 'custom') as VideoTag['category'],
      color: this.generateTagColor()
    }));

    // Transform transcript to TranscriptionSegment format
    let transcriptionSegments: TranscriptionSegment[] = [];
    if (transcript) {
      // Parse SRT format if available (database uses srt_format)
      const srtContent = transcript.srt_format || transcript.srt_content;
      const plainText = transcript.plain_text || transcript.txt_content;

      if (srtContent) {
        transcriptionSegments = this.parseSrtToSegments(srtContent);
      } else if (plainText) {
        // Simple text format - create single segment
        transcriptionSegments = [{
          id: 'seg-0',
          startTime: 0,
          endTime: parseDuration(video.duration || '0'),
          text: plainText,
          confidence: 1
        }];
      }
    }

    // Transform analysis to AIAnalysis format
    const aiAnalyses: AIAnalysis[] = [];
    if (analysis) {
      // Get the AI analysis content (database uses ai_analysis field)
      let analysisContent = analysis.ai_analysis || analysis.content || '';
      if (typeof analysisContent === 'string') {
        try {
          analysisContent = JSON.parse(analysisContent);
        } catch {
          // Keep as string
        }
      }

      // Only add individual sections as highlights (not the raw summary)
      if (sections.length > 0) {
        const highlights = sections.map(section => ({
          text: section.description || section.content,
          timestamp: section.start_seconds || section.start_time || 0,
          duration: (section.end_seconds || section.end_time || 0) - (section.start_seconds || section.start_time || 0),
          importance: 'medium' as const,
          category: (section.category || section.title || 'routine').toLowerCase()
        }));

        aiAnalyses.push({
          id: 'highlights-1',
          type: 'highlights',
          model: analysis.ai_model || analysis.model || 'Unknown',
          timestamp: new Date(analysis.analyzed_at || analysis.created_at || Date.now()),
          title: 'Video Sections',
          content: '',
          highlights,
          confidence: 0.85
        });
      }
    }

    // Get duration from database field
    const durationSeconds = video.duration_seconds || video.durationSeconds || parseDuration(video.duration || '0');

    // Get file size from database field
    const fileSize = video.file_size_bytes || video.fileSizeBytes || video.size || 0;

    // Get file extension/format
    const format = video.file_extension || video.fileExtension || '';

    return {
      id: video.id,
      title: video.name || video.filename || 'Untitled',
      description: video.ai_description || video.aiDescription || '',
      tags: videoTags,
      metadata: {
        duration: durationSeconds,
        fileSize: fileSize,
        resolution: 'N/A', // Not stored in database
        frameRate: 0,
        bitrate: 0,
        codec: 'N/A',
        format: format,
        aspectRatio: video.aspect_ratio_fixed ? 'Fixed' : 'Original',
        audioChannels: 0,
        audioBitrate: 0,
        audioCodec: 'N/A',
        audioSampleRate: 0,
        capturedDate: video.download_date ? new Date(video.download_date) :
                     video.downloadDate ? new Date(video.downloadDate) : undefined
      },
      aiAnalyses,
      transcription: transcriptionSegments,
      thumbnail: video.thumbnailUrl || video.thumbnail_url,
      videoUrl: video.current_path || video.filePath,
      uploadDate: video.uploadDate ? new Date(video.uploadDate) : undefined,
      downloadDate: video.downloadDate ? new Date(video.downloadDate) : new Date(),
      createdAt: video.download_date ? new Date(video.download_date) :
                video.downloadDate ? new Date(video.downloadDate) : new Date(),
      updatedAt: video.last_verified ? new Date(video.last_verified) : new Date(),
      processingStatus: {
        transcription: {
          status: transcriptionSegments.length > 0 ? 'completed' : 'pending',
          progress: transcriptionSegments.length > 0 ? 100 : 0
        },
        aiAnalysis: {
          status: aiAnalyses.length > 0 ? 'completed' : 'pending',
          progress: aiAnalyses.length > 0 ? 100 : 0
        },
        metadata: { status: 'completed', progress: 100 },
        overall: (transcriptionSegments.length > 0 && aiAnalyses.length > 0) ? 'completed' : 'pending'
      }
    };
  }

  /**
   * Parse SRT content to transcription segments
   */
  private parseSrtToSegments(srtContent: string): TranscriptionSegment[] {
    const segments: TranscriptionSegment[] = [];
    // Normalize line endings: convert \r\n (Windows) to \n (Unix)
    const normalizedContent = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalizedContent.trim().split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length < 3) continue;

      // Parse timestamp line (00:00:00,000 --> 00:00:01,000)
      const timeLine = lines[1];
      const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      if (!timeMatch) continue;

      const startTime = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]) + parseInt(timeMatch[4]) / 1000;
      const endTime = parseInt(timeMatch[5]) * 3600 + parseInt(timeMatch[6]) * 60 + parseInt(timeMatch[7]) + parseInt(timeMatch[8]) / 1000;

      // Get text (remaining lines)
      const text = lines.slice(2).join(' ').trim();

      segments.push({
        id: `seg-${segments.length}`,
        startTime,
        endTime,
        text,
        confidence: 1
      });
    }

    return segments;
  }

  private generateDemoTranscription(): TranscriptionSegment[] {
    // Generate demo transcription segments
    const segments: TranscriptionSegment[] = [];
    const speakers = ['CEO', 'CTO', 'Product Manager'];
    const sampleTexts = [
      "Good morning everyone, and welcome to our annual product launch event.",
      "Today, we're excited to announce groundbreaking features that will transform how you work with video content.",
      "Our new AI-powered editing capabilities reduce production time by up to 70%.",
      "Let me demonstrate the real-time collaboration features that our customers have been asking for.",
      "With support for over 50 languages, we're making video accessible to a global audience.",
      "Security has always been our top priority, and today we're introducing enterprise-grade encryption.",
      "Our analytics dashboard provides insights that were previously impossible to obtain.",
      "The feedback from our beta users has been overwhelmingly positive.",
      "Let's take a look at how Company X increased their productivity by 10x using our platform.",
      "These features will be available starting next month at competitive price points."
    ];

    for (let i = 0; i < 50; i++) {
      segments.push({
        id: `seg-${i}`,
        startTime: i * 10,
        endTime: (i + 1) * 10,
        text: sampleTexts[i % sampleTexts.length],
        speaker: speakers[i % speakers.length],
        confidence: 0.85 + Math.random() * 0.15
      });
    }

    return segments;
  }

  // Tag Management Methods
  addTag(): void {
    if (this.newTagName.trim() && this.videoInfo) {
      const newTag: VideoTag = {
        id: Math.random().toString(36).substr(2, 9),
        name: this.newTagName.trim(),
        category: this.newTagCategory,
        color: this.generateTagColor()
      };
      this.videoInfo.tags.push(newTag);
      this.newTagName = '';
      this.isAddingTag = false;
    }
  }

  removeTag(tagId: string): void {
    if (this.videoInfo) {
      this.videoInfo.tags = this.videoInfo.tags.filter(tag => tag.id !== tagId);
    }
  }

  addSuggestedTag(tagName: string): void {
    this.newTagName = tagName;
    this.addTag();
  }

  private generateTagColor(): string {
    const colors = ['#ff6b35', '#ffa366', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  // Description Methods
  editDescription(): void {
    if (this.videoInfo) {
      this.editedDescription = this.videoInfo.description;
      this.isEditingDescription = true;
    }
  }

  saveDescription(): void {
    if (this.videoInfo) {
      this.videoInfo.description = this.editedDescription;
      this.isEditingDescription = false;
    }
  }

  cancelDescriptionEdit(): void {
    this.isEditingDescription = false;
    this.editedDescription = '';
  }

  // Date Methods
  editDates(): void {
    if (this.videoInfo) {
      this.editedUploadDate = this.videoInfo.uploadDate
        ? this.formatDateForInput(this.videoInfo.uploadDate)
        : '';
      this.editedDownloadDate = this.formatDateForInput(this.videoInfo.downloadDate);
      this.isEditingDates = true;
    }
  }

  saveDates(): void {
    if (this.videoInfo) {
      const id = this.videoId || this.route.snapshot.paramMap.get('id');
      if (!id) return;

      console.log('Saving dates:', {
        uploadDate: this.editedUploadDate || null,
        downloadDate: this.editedDownloadDate
      });

      // Call backend to update dates
      this.http.patch<any>(`http://localhost:3000/api/database/videos/${id}/metadata`, {
        uploadDate: this.editedUploadDate || null,
        downloadDate: this.editedDownloadDate
      }).subscribe({
        next: (result) => {
          console.log('Save result:', result);
          if (result.success) {
            // Reload the video info to get updated filename and dates
            this.loadVideoInfo(id);
            this.isEditingDates = false;
          } else {
            console.error('Failed to save dates:', result.error);
            alert('Failed to save dates: ' + result.error);
          }
        },
        error: (err) => {
          console.error('Error saving dates:', err);
          alert('Error saving dates: ' + err.message);
        }
      });
    }
  }

  cancelDatesEdit(): void {
    this.isEditingDates = false;
    this.editedUploadDate = '';
    this.editedDownloadDate = '';
  }

  private formatDateForInput(date: Date): string {
    return new Date(date).toISOString().split('T')[0];
  }

  // AI Analysis Methods
  selectAnalysis(analysis: AIAnalysis): void {
    this.selectedAnalysis = this.selectedAnalysis?.id === analysis.id ? null : analysis;
  }

  getFilteredAnalyses(): AIAnalysis[] {
    if (!this.videoInfo) return [];
    if (this.analysisFilter === 'all') return this.videoInfo.aiAnalyses;
    return this.videoInfo.aiAnalyses.filter(a => a.type === this.analysisFilter);
  }

  formatAnalysisContent(analysis: AIAnalysis): string {
    if (typeof analysis.content === 'string') {
      return analysis.content;
    }
    return JSON.stringify(analysis.content, null, 2);
  }

  deleteSection(index: number, event: Event): void {
    event.stopPropagation();
    if (!this.videoInfo) return;

    // Find the highlights analysis and remove the section at the given index
    const highlightsAnalysis = this.videoInfo.aiAnalyses.find(a => a.type === 'highlights');
    if (highlightsAnalysis && highlightsAnalysis.highlights) {
      highlightsAnalysis.highlights.splice(index, 1);

      // TODO: Call backend to delete the section from database
      // const videoId = this.videoId || this.route.snapshot.paramMap.get('id');
      // this.libraryService.deleteSection(videoId, sectionId).subscribe();
    }
  }

  // Transcription Methods
  searchTranscription(): void {
    if (!this.videoInfo || !this.transcriptionSearchQuery.trim()) {
      this.transcriptionSearchResults = [];
      return;
    }

    const query = this.transcriptionSearchQuery.toLowerCase();
    const results: TranscriptionSearchResult[] = [];

    this.videoInfo.transcription.forEach((segment, index) => {
      const text = segment.text.toLowerCase();
      if (text.includes(query)) {
        const matchIndex = text.indexOf(query);
        const before = segment.text.substring(Math.max(0, matchIndex - 50), matchIndex);
        const after = segment.text.substring(
          matchIndex + query.length,
          Math.min(segment.text.length, matchIndex + query.length + 50)
        );

        results.push({
          segment,
          matchedText: segment.text.substring(matchIndex, matchIndex + query.length),
          context: { before, after }
        });
      }
    });

    this.transcriptionSearchResults = results;
  }

  clearSearch(): void {
    this.transcriptionSearchQuery = '';
    this.transcriptionSearchResults = [];
    this.highlightedSegmentId = null;
  }

  jumpToSegment(segment: TranscriptionSegment): void {
    this.highlightedSegmentId = segment.id;
    this.playbackPosition = segment.startTime;
    // In real app, would trigger video player seek
    console.log(`Jumping to ${this.formatTime(segment.startTime)}`);

    // Scroll to segment
    setTimeout(() => {
      const element = document.getElementById(`segment-${segment.id}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }

  exportTranscription(format: 'txt' | 'srt' | 'vtt' | 'json'): void {
    if (!this.videoInfo) return;

    let content = '';
    const transcription = this.videoInfo.transcription;

    switch (format) {
      case 'txt':
        content = transcription.map(seg =>
          `[${this.formatTime(seg.startTime)}] ${seg.speaker || 'Speaker'}: ${seg.text}`
        ).join('\n\n');
        break;

      case 'srt':
        content = transcription.map((seg, i) =>
          `${i + 1}\n${this.formatTimeSRT(seg.startTime)} --> ${this.formatTimeSRT(seg.endTime)}\n${seg.text}\n`
        ).join('\n');
        break;

      case 'vtt':
        content = 'WEBVTT\n\n' + transcription.map(seg =>
          `${this.formatTimeVTT(seg.startTime)} --> ${this.formatTimeVTT(seg.endTime)}\n${seg.text}\n`
        ).join('\n');
        break;

      case 'json':
        content = JSON.stringify(transcription, null, 2);
        break;
    }

    // Create download
    const blob = new Blob([content], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcription.${format}`;
    a.click();
    window.URL.revokeObjectURL(url);
  }

  getContinuousTranscription(): string {
    if (!this.videoInfo) return '';
    return this.videoInfo.transcription
      .map(seg => seg.text)
      .join(' ');
  }

  // Utility Methods
  // ============================================================================
  // CHILDREN MANAGEMENT
  // ============================================================================

  private loadChildren(videoId: string): void {
    // Load children
    this.http.get<any>(`http://localhost:3000/api/database/videos/${videoId}/children`)
      .subscribe({
        next: (response) => {
          if (response.success && response.children) {
            this.childVideos = response.children;
            console.log(`Loaded ${this.childVideos.length} children for video ${videoId}`);
            // Force change detection to update the view immediately
            this.cdr.detectChanges();
          } else {
            console.warn('Failed to load children:', response.error || 'Unknown error');
            this.childVideos = [];
          }
        },
        error: (err) => {
          console.error('Failed to load children:', err);
          this.childVideos = [];
        }
      });

    // Load parents
    this.http.get<any>(`http://localhost:3000/api/database/videos/${videoId}/parents`)
      .subscribe({
        next: (response) => {
          if (response.success && response.parents) {
            this.parentVideos = response.parents;
            console.log(`Loaded ${this.parentVideos.length} parents for video ${videoId}`);
            // Force change detection to update the view immediately
            this.cdr.detectChanges();
          } else {
            console.warn('Failed to load parents:', response.error || 'Unknown error');
            this.parentVideos = [];
          }
        },
        error: (err) => {
          console.error('Failed to load parents:', err);
          this.parentVideos = [];
        }
      });
  }

  openVideoSelector(): void {
    this.showVideoSelector = true;

    const currentId = this.videoId || this.route.snapshot.paramMap.get('id');

    this.libraryService.getVideosByWeek().subscribe({
      next: (response) => {
        if (!response.success || !response.data) {
          console.error('Library load failed:', response);
          this.showVideoSelector = false;
          return;
        }

        const weeks = response.data;
        const childIds = new Set(this.childVideos.map(c => c.id));

        // Filter videos
        const filteredWeeks = weeks.map((week: VideoWeek) => ({
          ...week,
          videos: week.videos.filter((v: VideoItem) =>
            v.id !== currentId && !childIds.has(v.id)
          )
        }))
        .filter((week: VideoWeek) => week.videos.length > 0);

        // Keep weeks in original order (newest first: 2025 at top, 2016 at bottom)
        this.availableVideosWeek = filteredWeeks;
      },
      error: (err) => {
        console.error('Failed to load library:', err);
        this.showVideoSelector = false;
      }
    });
  }

  onVideoSelectorSelectionChanged(event: { count: number; ids: Set<string> }): void {
    this.selectedVideosForLink = event.ids;
  }

  get filteredAvailableVideosWeek(): VideoWeek[] {
    if (!this.videoSearchQuery || this.videoSearchQuery.trim() === '') {
      return this.availableVideosWeek;
    }

    const query = this.videoSearchQuery.toLowerCase();
    return this.availableVideosWeek.map(week => ({
      ...week,
      videos: week.videos.filter(v =>
        v.name?.toLowerCase().includes(query)
      )
    })).filter(week => week.videos.length > 0);
  }

  addSelectedChildren(): void {
    if (this.selectedVideosForLink.size === 0) return;

    const currentId = this.videoId || this.route.snapshot.paramMap.get('id');

    // Extract video IDs from itemIds (format: "weekLabel|videoId")
    // The cascade component uses itemIds in format "weekLabel|videoId" for uniqueness
    const childIds = Array.from(this.selectedVideosForLink).map(itemId => {
      // Extract video ID from itemId (everything after the last "|")
      const parts = itemId.split('|');
      return parts.length > 1 ? parts[parts.length - 1] : itemId;
    });

    this.http.post<any>(`http://localhost:3000/api/database/videos/${currentId}/add-children`, {
      childIds
    }).subscribe({
      next: (response) => {
        if (response.success) {
          // Reload children to get complete data with thumbnails
          this.loadChildren(currentId!);

          // Close selector and clear selection
          this.cancelVideoSelection();
        } else {
          console.error('Failed to add children:', response.error);
          alert('Failed to add children: ' + (response.error || 'Unknown error'));
        }
      },
      error: (err) => {
        console.error('Failed to add children:', err);
        alert('Error adding children: ' + (err.error?.error || err.message || 'Unknown error'));
      }
    });
  }

  cancelVideoSelection(): void {
    this.showVideoSelector = false;
    this.selectedVideosForLink.clear();
    this.videoSearchQuery = '';
  }

  removeChild(childId: string): void {
    const currentId = this.videoId || this.route.snapshot.paramMap.get('id');
    this.http.post<any>(`http://localhost:3000/api/database/videos/${currentId}/remove-child/${childId}`, {})
      .subscribe({
        next: (response) => {
          if (response.success) {
            // Reload children
            this.loadChildren(currentId!);
          }
        },
        error: (err) => {
          console.error('Failed to remove child:', err);
        }
      });
  }

  removeAllChildren(): void {
    if (!confirm('Are you sure you want to remove all children from this video?')) {
      return;
    }

    const currentId = this.videoId || this.route.snapshot.paramMap.get('id');
    this.http.post<any>(`http://localhost:3000/api/database/videos/${currentId}/remove-all-children`, {})
      .subscribe({
        next: (response) => {
          if (response.success) {
            this.childVideos = [];
          }
        },
        error: (err) => {
          console.error('Failed to remove all children:', err);
        }
      });
  }

  removeParent(parentId: string): void {
    const currentId = this.videoId || this.route.snapshot.paramMap.get('id');
    if (!currentId) return;

    // Use the library service method to remove the parent-child relationship
    this.libraryService.removeParentChildRelationship(parentId, currentId).subscribe({
      next: (response) => {
        if (response.success) {
          // Reload parents to reflect the change
          this.loadChildren(currentId);
        }
      },
      error: (err) => {
        console.error('Failed to remove parent:', err);
      }
    });
  }

  removeAllRelationships(): void {
    if (!confirm('Are you sure you want to remove all parent and child relationships from this video?')) {
      return;
    }

    const currentId = this.videoId || this.route.snapshot.paramMap.get('id');

    // Remove all children
    this.http.post<any>(`http://localhost:3000/api/database/videos/${currentId}/remove-all-children`, {})
      .subscribe({
        next: (response) => {
          if (response.success) {
            this.childVideos = [];
          }
        },
        error: (err) => {
          console.error('Failed to remove all children:', err);
        }
      });

    // Remove all parents (remove this video as a child from all its parents)
    for (const parent of this.parentVideos) {
      this.libraryService.removeParentChildRelationship(parent.id, currentId!).subscribe({
        next: (response) => {
          if (response.success) {
            this.parentVideos = [];
          }
        },
        error: (err) => {
          console.error('Failed to remove parent:', err);
        }
      });
    }
  }

  getTotalRelationshipsCount(): number {
    return this.childVideos.length + this.parentVideos.length;
  }

  navigateToVideo(videoId: string): void {
    this.router.navigate(['/video', videoId]);
  }

  // ============================================================================
  // FORMATTING UTILITIES
  // ============================================================================

  formatFileSize(bytes: number): string {
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }

  formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  }

  formatTimeSRT(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  }

  formatTimeVTT(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }

  formatDate(date: Date): string {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  toggleSection(section: keyof typeof this.expandedSections): void {
    this.expandedSections[section] = !this.expandedSections[section];
  }

  onThumbnailError(event: Event): void {
    const img = event.target as HTMLImageElement;
    img.src = 'assets/default-thumbnail.png';
  }
}