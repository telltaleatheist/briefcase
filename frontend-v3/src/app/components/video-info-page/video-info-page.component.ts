import { Component, OnInit, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin } from 'rxjs';
import {
  VideoInfo,
  VideoTag,
  AIAnalysis,
  TranscriptionSegment,
  TranscriptionSearchResult
} from '../../models/video-info.model';
import { LibraryService } from '../../services/library.service';

@Component({
  selector: 'app-video-info-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './video-info-page.component.html',
  styleUrls: ['./video-info-page.component.scss']
})
export class VideoInfoPageComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private libraryService = inject(LibraryService);

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

  // UI State
  activeTab: 'overview' | 'metadata' | 'ai-analysis' | 'transcription' = 'overview';
  expandedSections = {
    tags: true,
    description: true,
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
    const videoTags: VideoTag[] = tags.map((tag, index) => ({
      id: `tag-${index}`,
      name: tag,
      category: 'custom' as const,
      color: this.generateTagColor()
    }));

    // Transform transcript to TranscriptionSegment format
    let transcriptionSegments: TranscriptionSegment[] = [];
    if (transcript) {
      // Parse SRT format if available
      if (transcript.srt_content) {
        transcriptionSegments = this.parseSrtToSegments(transcript.srt_content);
      } else if (transcript.txt_content) {
        // Simple text format - create single segment
        transcriptionSegments = [{
          id: 'seg-0',
          startTime: 0,
          endTime: parseDuration(video.duration),
          text: transcript.txt_content,
          confidence: 1
        }];
      }
    }

    // Transform analysis to AIAnalysis format
    const aiAnalyses: AIAnalysis[] = [];
    if (analysis) {
      // Try to parse content as JSON if it's a string
      let analysisContent = analysis.content;
      if (typeof analysisContent === 'string') {
        try {
          analysisContent = JSON.parse(analysisContent);
        } catch {
          // Keep as string
        }
      }

      aiAnalyses.push({
        id: analysis.id || 'analysis-1',
        type: 'summary',
        model: analysis.model || 'Unknown',
        timestamp: new Date(analysis.created_at || Date.now()),
        title: 'AI Analysis',
        content: typeof analysisContent === 'string' ? analysisContent : JSON.stringify(analysisContent, null, 2),
        confidence: 0.9
      });

      // Add sections as highlights
      if (sections.length > 0) {
        const highlights = sections.map(section => ({
          text: section.title || section.content,
          timestamp: section.start_time || 0,
          duration: (section.end_time || 0) - (section.start_time || 0),
          importance: 'medium' as const,
          category: section.type || 'Section'
        }));

        aiAnalyses.push({
          id: 'highlights-1',
          type: 'highlights',
          model: analysis.model || 'Unknown',
          timestamp: new Date(),
          title: 'Key Sections',
          content: '',
          highlights,
          confidence: 0.85
        });
      }
    }

    return {
      id: video.id,
      title: video.name || video.filename || 'Untitled',
      description: video.aiDescription || video.ai_description || '',
      tags: videoTags,
      metadata: {
        duration: parseDuration(video.duration),
        fileSize: video.size || video.file_size || 0,
        resolution: video.resolution || '',
        frameRate: video.frame_rate || 0,
        bitrate: video.bitrate || 0,
        codec: video.codec || '',
        format: video.format || video.fileExtension || '',
        aspectRatio: video.aspect_ratio || '',
        audioChannels: video.audio_channels || 0,
        audioBitrate: video.audio_bitrate || 0,
        audioCodec: video.audio_codec || '',
        audioSampleRate: video.audio_sample_rate || 0,
        capturedDate: video.downloadDate ? new Date(video.downloadDate) : undefined
      },
      aiAnalyses,
      transcription: transcriptionSegments,
      thumbnail: video.thumbnailUrl,
      videoUrl: video.filePath,
      createdAt: video.downloadDate ? new Date(video.downloadDate) : new Date(),
      updatedAt: new Date(),
      processingStatus: {
        transcription: {
          status: video.hasTranscript ? 'completed' : 'pending',
          progress: video.hasTranscript ? 100 : 0
        },
        aiAnalysis: {
          status: video.hasAnalysis ? 'completed' : 'pending',
          progress: video.hasAnalysis ? 100 : 0
        },
        metadata: { status: 'completed', progress: 100 },
        overall: (video.hasTranscript && video.hasAnalysis) ? 'completed' : 'pending'
      }
    };
  }

  /**
   * Parse SRT content to transcription segments
   */
  private parseSrtToSegments(srtContent: string): TranscriptionSegment[] {
    const segments: TranscriptionSegment[] = [];
    const blocks = srtContent.trim().split(/\n\n+/);

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
}