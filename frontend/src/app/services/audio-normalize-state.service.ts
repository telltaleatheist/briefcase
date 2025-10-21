import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export interface AudioFile {
  path: string;
  name: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AudioNormalizeStateService {
  private filesSubject = new BehaviorSubject<AudioFile[]>([]);
  private isProcessingSubject = new BehaviorSubject<boolean>(false);
  private targetVolumeSubject = new BehaviorSubject<number>(-20);

  constructor() {
    // Files are intentionally NOT loaded from storage
    // They should be cleared when the app closes
  }

  /**
   * Get the current files as an observable
   */
  getFiles(): Observable<AudioFile[]> {
    return this.filesSubject.asObservable();
  }

  /**
   * Get the current files value
   */
  getFilesValue(): AudioFile[] {
    return this.filesSubject.value;
  }

  /**
   * Set the files list
   */
  setFiles(files: AudioFile[]): void {
    this.filesSubject.next(files);
  }

  /**
   * Add files to the list
   */
  addFiles(files: AudioFile[]): void {
    const currentFiles = this.filesSubject.value;
    this.filesSubject.next([...currentFiles, ...files]);
  }

  /**
   * Update a file by index
   */
  updateFile(index: number, updates: Partial<AudioFile>): void {
    const currentFiles = this.filesSubject.value;
    if (index >= 0 && index < currentFiles.length) {
      const updatedFiles = [...currentFiles];
      updatedFiles[index] = { ...updatedFiles[index], ...updates };
      this.filesSubject.next(updatedFiles);
    }
  }

  /**
   * Remove a file by index
   */
  removeFile(index: number): void {
    const currentFiles = this.filesSubject.value;
    const filteredFiles = currentFiles.filter((_, i) => i !== index);
    this.filesSubject.next(filteredFiles);
  }

  /**
   * Clear all files
   */
  clearFiles(): void {
    this.filesSubject.next([]);
  }

  /**
   * Get processing state
   */
  getIsProcessing(): Observable<boolean> {
    return this.isProcessingSubject.asObservable();
  }

  /**
   * Get processing state value
   */
  getIsProcessingValue(): boolean {
    return this.isProcessingSubject.value;
  }

  /**
   * Set processing state
   */
  setIsProcessing(isProcessing: boolean): void {
    this.isProcessingSubject.next(isProcessing);
  }

  /**
   * Get target volume
   */
  getTargetVolume(): Observable<number> {
    return this.targetVolumeSubject.asObservable();
  }

  /**
   * Get target volume value
   */
  getTargetVolumeValue(): number {
    return this.targetVolumeSubject.value;
  }

  /**
   * Set target volume
   */
  setTargetVolume(volume: number): void {
    this.targetVolumeSubject.next(volume);
  }
}