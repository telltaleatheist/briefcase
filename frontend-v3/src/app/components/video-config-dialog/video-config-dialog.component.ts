import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VideoJobSettings } from '../../models/video-processing.model';

@Component({
  selector: 'app-video-config-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './video-config-dialog.component.html',
  styleUrls: ['./video-config-dialog.component.scss']
})
export class VideoConfigDialogComponent {
  @Input() isOpen = false;
  @Input() videoName = '';
  @Input() videoUrl = '';
  @Output() closeDialog = new EventEmitter<void>();
  @Output() submitConfig = new EventEmitter<{ url: string; name: string; settings: VideoJobSettings }>();

  settings: VideoJobSettings = {
    fixAspectRatio: false,
    aspectRatio: '16:9',
    normalizeAudio: false,
    audioLevel: -6,
    transcribe: false,
    whisperModel: 'base',
    whisperLanguage: 'auto',
    aiAnalysis: false,
    aiModel: 'gpt-3.5-turbo',
    customInstructions: '',
    outputFormat: 'mp4',
    outputQuality: 'high'
  };

  // Preset configurations
  presets = [
    {
      name: 'Quick Process',
      description: 'Basic import only',
      settings: {
        fixAspectRatio: false,
        normalizeAudio: false,
        transcribe: false,
        aiAnalysis: false
      }
    },
    {
      name: 'Social Media',
      description: 'Optimize for sharing',
      settings: {
        fixAspectRatio: true,
        aspectRatio: '1:1' as const,
        normalizeAudio: true,
        transcribe: true,
        aiAnalysis: false,
        outputQuality: 'medium' as const
      }
    },
    {
      name: 'Full Analysis',
      description: 'Complete processing',
      settings: {
        fixAspectRatio: true,
        normalizeAudio: true,
        transcribe: true,
        aiAnalysis: true,
        whisperModel: 'large-v3' as const,
        aiModel: 'gpt-4' as const,
        outputQuality: 'ultra' as const
      }
    },
    {
      name: 'Accessibility',
      description: 'Focus on transcription',
      settings: {
        fixAspectRatio: false,
        normalizeAudio: true,
        transcribe: true,
        whisperModel: 'large-v3' as const,
        aiAnalysis: false
      }
    }
  ];

  aspectRatios = ['16:9', '4:3', '1:1', '9:16'];
  whisperModels = [
    { value: 'tiny', label: 'Tiny (39M, fastest)' },
    { value: 'base', label: 'Base (74M, fast)' },
    { value: 'small', label: 'Small (244M, balanced)' },
    { value: 'medium', label: 'Medium (769M, accurate)' },
    { value: 'large', label: 'Large (1550M, slow)' },
    { value: 'large-v2', label: 'Large V2 (better)' },
    { value: 'large-v3', label: 'Large V3 (best)' }
  ];
  aiModels = [
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (fast)' },
    { value: 'gpt-4', label: 'GPT-4 (accurate)' },
    { value: 'claude-2', label: 'Claude 2' },
    { value: 'claude-3', label: 'Claude 3' },
    { value: 'llama-2', label: 'Llama 2 (local)' }
  ];
  outputFormats = ['mp4', 'webm', 'mov', 'avi'];
  outputQualities = ['low', 'medium', 'high', 'ultra'];

  activeTab: 'basic' | 'advanced' | 'ai' = 'basic';

  applyPreset(preset: any): void {
    this.settings = { ...this.settings, ...preset.settings };
  }

  onSubmit(): void {
    if (this.videoUrl || this.videoName) {
      this.submitConfig.emit({
        url: this.videoUrl,
        name: this.videoName || this.extractNameFromUrl(this.videoUrl),
        settings: { ...this.settings }
      });
      this.close();
    }
  }

  close(): void {
    this.closeDialog.emit();
    this.resetForm();
  }

  private resetForm(): void {
    this.videoUrl = '';
    this.videoName = '';
    this.settings = {
      fixAspectRatio: false,
      aspectRatio: '16:9',
      normalizeAudio: false,
      audioLevel: -6,
      transcribe: false,
      whisperModel: 'base',
      whisperLanguage: 'auto',
      aiAnalysis: false,
      aiModel: 'gpt-3.5-turbo',
      customInstructions: '',
      outputFormat: 'mp4',
      outputQuality: 'high'
    };
    this.activeTab = 'basic';
  }

  private extractNameFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;
      const filename = path.split('/').pop() || 'Untitled Video';
      return filename.replace(/\.[^/.]+$/, '');
    } catch {
      return 'Untitled Video';
    }
  }

  calculateEstimatedTime(): number {
    let time = 10; // Base import time
    if (this.videoUrl) time += 30; // Download time
    if (this.settings.fixAspectRatio) time += 45;
    if (this.settings.normalizeAudio) time += 20;
    if (this.settings.transcribe) {
      const modelTime = {
        'tiny': 30,
        'base': 40,
        'small': 50,
        'medium': 70,
        'large': 90,
        'large-v2': 100,
        'large-v3': 110
      };
      time += modelTime[this.settings.whisperModel!] || 40;
    }
    if (this.settings.aiAnalysis) time += 30;
    return time;
  }

  getActiveTaskCount(): number {
    let count = 1; // Import is always done
    if (this.videoUrl) count++; // Download
    if (this.settings.fixAspectRatio) count++;
    if (this.settings.normalizeAudio) count++;
    if (this.settings.transcribe) count++;
    if (this.settings.aiAnalysis) count++;
    return count;
  }
}