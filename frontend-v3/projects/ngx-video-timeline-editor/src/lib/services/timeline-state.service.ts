import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import {
  TimelineState,
  TimelineSection,
  TimelineSelection,
  TimelineTool,
  CategoryFilter,
  ZoomState
} from '../models';

@Injectable({
  providedIn: 'root'
})
export class TimelineStateService {
  private readonly initialState: TimelineState = {
    duration: 0,
    currentTime: 0,
    isPlaying: false,
    selection: { startTime: 0, endTime: 0 },
    sections: [],
    categoryFilters: [],
    zoomState: { level: 1, offset: 0 },
    selectedTool: 'cursor',
    autoFollowPlayhead: true
  };

  private state$ = new BehaviorSubject<TimelineState>(this.initialState);

  // Expose state as observable
  get state(): Observable<TimelineState> {
    return this.state$.asObservable();
  }

  // Expose current state value
  get currentState(): TimelineState {
    return this.state$.value;
  }

  // Duration
  setDuration(duration: number): void {
    this.updateState({ duration });
  }

  // Current time
  setCurrentTime(currentTime: number): void {
    this.updateState({ currentTime });
  }

  // Playback state
  setIsPlaying(isPlaying: boolean): void {
    this.updateState({ isPlaying });
  }

  // Selection
  setSelection(selection: TimelineSelection): void {
    this.updateState({ selection });
  }

  setSelectionStart(startTime: number): void {
    const selection = {
      ...this.currentState.selection,
      startTime,
      endTime: Math.max(startTime + 1, this.currentState.selection.endTime)
    };
    this.updateState({ selection });
  }

  setSelectionEnd(endTime: number): void {
    const selection = {
      ...this.currentState.selection,
      startTime: Math.min(this.currentState.selection.startTime, endTime - 1),
      endTime
    };
    this.updateState({ selection });
  }

  // Sections
  setSections(sections: TimelineSection[]): void {
    this.updateState({ sections });
    this.updateCategoryFilters(sections);
  }

  addSection(section: TimelineSection): void {
    const sections = [...this.currentState.sections, section];
    this.setSections(sections);
  }

  removeSection(index: number): void {
    const sections = this.currentState.sections.filter((_, i) => i !== index);
    this.setSections(sections);
  }

  // Category filters
  private updateCategoryFilters(sections: TimelineSection[]): void {
    const categories = new Map<string, CategoryFilter>();

    sections.forEach(section => {
      const category = section.category.toLowerCase();
      if (!categories.has(category)) {
        categories.set(category, {
          category,
          label: section.category,
          color: section.color,
          enabled: true
        });
      }
    });

    const categoryFilters = Array.from(categories.values())
      .sort((a, b) => a.label.localeCompare(b.label));

    this.updateState({ categoryFilters });
  }

  toggleCategoryFilter(category: string): void {
    const categoryFilters = this.currentState.categoryFilters.map(filter =>
      filter.category === category.toLowerCase()
        ? { ...filter, enabled: !filter.enabled }
        : filter
    );
    this.updateState({ categoryFilters });
  }

  // Zoom
  setZoom(level: number, offset: number): void {
    this.updateState({
      zoomState: { level, offset }
    });
  }

  setZoomLevel(level: number): void {
    this.updateState({
      zoomState: { ...this.currentState.zoomState, level }
    });
  }

  setZoomOffset(offset: number): void {
    this.updateState({
      zoomState: { ...this.currentState.zoomState, offset }
    });
  }

  // Tool
  setSelectedTool(selectedTool: TimelineTool): void {
    this.updateState({ selectedTool });
  }

  // Auto-follow playhead
  setAutoFollowPlayhead(autoFollowPlayhead: boolean): void {
    this.updateState({ autoFollowPlayhead });
  }

  toggleAutoFollowPlayhead(): void {
    this.updateState({
      autoFollowPlayhead: !this.currentState.autoFollowPlayhead
    });
  }

  // Reset state
  reset(): void {
    this.state$.next(this.initialState);
  }

  // Private helper to update state
  private updateState(partial: Partial<TimelineState>): void {
    this.state$.next({
      ...this.currentState,
      ...partial
    });
  }
}
