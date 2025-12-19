import { Injectable, signal } from '@angular/core';
import { driver, DriveStep, Driver, Config } from 'driver.js';

export interface TourStep {
  element?: string; // CSS selector
  title: string;
  description: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

export interface PageTour {
  id: string;
  name: string;
  steps: TourStep[];
}

@Injectable({
  providedIn: 'root'
})
export class TourService {
  private driverInstance: Driver | null = null;

  // Track if a tour is currently running
  isRunning = signal(false);

  // Signal that emits when a tour completes (with the tour ID)
  lastCompletedTour = signal<string | null>(null);

  // Tour definitions for each page
  private tours: Map<string, PageTour> = new Map();

  // Queue for next tour to run after current one completes
  private pendingTourId: string | null = null;

  // LocalStorage key for tracking completed tours
  private readonly STORAGE_KEY = 'clipchimp_completed_tours';

  constructor() {
    this.initializeTours();
  }

  /**
   * Initialize all tour definitions
   */
  private initializeTours(): void {
    // Welcome tour - explains common UI elements (only shown once on first app visit)
    this.tours.set('welcome', {
      id: 'welcome',
      name: 'Welcome Tour',
      steps: [
        {
          element: '.tabs-section',
          title: 'Navigation Tabs',
          description: 'Switch between Library, Queue, Tabs, Manager, Saved for Later, and Settings. Each tab provides different functionality.',
          side: 'bottom',
        },
        {
          element: '.header-actions',
          title: 'Action Buttons',
          description: 'Download videos from URLs, import local files, open the video editor, or view details about selected videos.',
          side: 'bottom',
        },
        {
          element: '.header-right .tour-button',
          title: 'Tutorial Button',
          description: 'Click this button anytime to see a tutorial for the current screen. Each screen has its own guide!',
          side: 'bottom',
        },
      ],
    });

    // Library tab tour - only library-specific content
    this.tours.set('library', {
      id: 'library',
      name: 'Library Tour',
      steps: [
        {
          element: '.filters-section',
          title: 'Search & Filters',
          description: 'Search your videos by name, filter by tags or categories, and sort by different criteria to find exactly what you need.',
          side: 'bottom',
        },
        {
          element: 'app-cascade',
          title: 'Video Grid',
          description: 'Your videos are organized by date. Click to select, double-click to preview, or right-click for options like analyze, rename, or delete.',
          side: 'top',
        },
      ],
    });

    // Cascade component tour - explains the video grid when first encountered
    this.tours.set('cascade', {
      id: 'cascade',
      name: 'Video Grid Tour',
      steps: [
        {
          element: '.cascade',
          title: 'Video Grid',
          description: 'Videos are grouped by week. Click the week header to collapse/expand. Each card shows a thumbnail, title, and duration.',
          side: 'top',
        },
        {
          element: '.cascade-item',
          title: 'Video Cards',
          description: 'Click a card to select it. Hold Ctrl/Cmd to select multiple. Double-click to preview. Right-click for actions menu.',
          side: 'right',
        },
      ],
    });

    // Settings page tour - only settings-specific content
    this.tours.set('settings', {
      id: 'settings',
      name: 'Settings Tour',
      steps: [
        {
          element: '.settings-content',
          title: 'Settings Overview',
          description: 'Configure AI providers, default models, analysis categories, and custom prompts. Each section controls a different aspect of video analysis.',
          side: 'top',
        },
        {
          element: '.settings-section:nth-child(1)',
          title: 'AI Configuration',
          description: 'Set up which AI provider to use (Local AI, Ollama, Claude, or OpenAI). The status card shows if AI is ready.',
          side: 'right',
        },
        {
          element: '.settings-section:nth-child(2)',
          title: 'Default AI Model',
          description: 'Choose which model to use by default when analyzing videos. This saves you from selecting a model each time.',
          side: 'right',
        },
        {
          element: '.settings-section:nth-child(3)',
          title: 'Analysis Categories',
          description: 'Define categories for AI to classify video content. Add custom categories like "interview", "tutorial", or "news".',
          side: 'right',
        },
        {
          element: '.settings-section:nth-child(4)',
          title: 'AI Prompts',
          description: 'Customize how AI analyzes your videos. Edit prompts for descriptions, titles, tags, and quote extraction.',
          side: 'right',
        },
      ],
    });

    // Video editor tour
    this.tours.set('video-editor', {
      id: 'video-editor',
      name: 'Video Editor Tour',
      steps: [
        {
          element: '.video-player-area',
          title: 'Video Player',
          description: 'Preview your video here. Use keyboard shortcuts: Space to play/pause, Arrow keys to seek, J/K/L for playback control.',
          side: 'bottom',
        },
        {
          element: '.timeline-area',
          title: 'Timeline',
          description: 'The timeline shows your video with waveform visualization. Click to seek, drag to scrub, or use the tools to create clips.',
          side: 'top',
        },
        {
          element: '.timeline-toolbar',
          title: 'Timeline Tools',
          description: 'Add markers, zoom in/out, toggle waveform display, and use marker controls to navigate your video.',
          side: 'bottom',
        },
        {
          element: '.analysis-panel',
          title: 'Analysis Panel',
          description: 'View AI-detected sections, transcript, and your custom markers. Click any item to jump to that point in the video.',
          side: 'left',
        },
        {
          element: '.editor-header',
          title: 'Editor Controls',
          description: 'Access quick actions like fullscreen mode, close editor, and see the current video title.',
          side: 'bottom',
        },
      ],
    });

    // AI Setup Wizard - Welcome step tour
    this.tours.set('ai-wizard', {
      id: 'ai-wizard',
      name: 'AI Setup Tour',
      steps: [
        {
          element: '.wizard-container',
          title: 'Welcome to AI Setup',
          description: 'This wizard will help you configure AI for video analysis. AI powers features like automatic transcription, content analysis, and smart tagging.',
          side: 'bottom',
        },
        {
          element: '.provider-card.recommended',
          title: 'Local AI (Recommended)',
          description: 'Run AI directly on your computer. It\'s free, private, and works offline. Great for most users with a modern computer.',
          side: 'right',
        },
        {
          element: '.provider-cards',
          title: 'Other Options',
          description: 'You can also use Ollama (if installed), or cloud services like Claude or OpenAI for higher quality results.',
          side: 'bottom',
        },
      ],
    });

    // AI Wizard - Local Models step tour
    this.tours.set('ai-wizard-local', {
      id: 'ai-wizard-local',
      name: 'Local AI Setup Tour',
      steps: [
        {
          element: '.system-info-card',
          title: 'Your System',
          description: 'Shows your GPU and RAM. Models run faster on GPU. The recommended model is chosen based on your available memory.',
          side: 'bottom',
        },
        {
          element: '.model-cards',
          title: 'Choose a Model',
          description: 'Larger models (more GB) give better results but need more memory. The "Recommended" badge shows the best choice for your system.',
          side: 'top',
        },
        {
          element: '.model-card .model-actions',
          title: 'Download or Activate',
          description: 'Click Download to get a model. Once downloaded, click "Use This" to make it your default. You can have multiple models.',
          side: 'left',
        },
      ],
    });

    // AI Wizard - Ollama step tour
    this.tours.set('ai-wizard-ollama', {
      id: 'ai-wizard-ollama',
      name: 'Ollama Setup Tour',
      steps: [
        {
          element: '.instruction-card',
          title: 'Install Ollama',
          description: 'Follow these steps to install Ollama on your computer. Click the button to open the Ollama website.',
          side: 'right',
        },
        {
          element: '.models-section',
          title: 'Download a Model',
          description: 'After installing Ollama, download a model. Larger models (more B) are smarter but need more RAM. Mistral 7B is a good starting point.',
          side: 'top',
        },
        {
          element: '.status-section',
          title: 'Check Status',
          description: 'Click "Check Ollama Status" to verify Ollama is running and has models available. Green checkmark means you\'re ready!',
          side: 'top',
        },
      ],
    });

    // AI Wizard - Claude step tour
    this.tours.set('ai-wizard-claude', {
      id: 'ai-wizard-claude',
      name: 'Claude API Setup Tour',
      steps: [
        {
          element: '.instruction-card',
          title: 'Get an API Key',
          description: 'You need an API key from Anthropic to use Claude. Click the button to open the Anthropic Console and create a key.',
          side: 'right',
        },
        {
          element: '.api-input-section',
          title: 'Enter Your Key',
          description: 'Paste your Claude API key here. It starts with "sk-ant-". Your key is stored locally and only sent to Anthropic\'s servers.',
          side: 'top',
        },
      ],
    });

    // AI Wizard - OpenAI step tour
    this.tours.set('ai-wizard-openai', {
      id: 'ai-wizard-openai',
      name: 'OpenAI API Setup Tour',
      steps: [
        {
          element: '.instruction-card',
          title: 'Get an API Key',
          description: 'You need an API key from OpenAI to use GPT models. Click the button to open the OpenAI Platform and create a key.',
          side: 'right',
        },
        {
          element: '.api-input-section',
          title: 'Enter Your Key',
          description: 'Paste your OpenAI API key here. It starts with "sk-". Your key is stored locally and only sent to OpenAI\'s servers.',
          side: 'top',
        },
      ],
    });

    // Queue tab tour
    this.tours.set('queue', {
      id: 'queue',
      name: 'Queue Tour',
      steps: [
        {
          element: '.queue-toolbar',
          title: 'Queue Overview',
          description: 'Shows how many videos are staging (waiting) vs processing (active). Staging items need to be started, processing items are running.',
          side: 'bottom',
        },
        {
          element: '.toolbar-actions',
          title: 'Queue Actions',
          description: 'Configure tasks for selected items, remove them from queue, or start processing. "Process All" starts everything at once.',
          side: 'bottom',
        },
        {
          element: '.queue-content',
          title: 'Queue Items',
          description: 'Videos show their processing status with progress bars. Green = complete, blue = processing, gray = waiting. Click to select, right-click for options.',
          side: 'top',
        },
      ],
    });

    // Tabs tab tour
    this.tours.set('tabs', {
      id: 'tabs',
      name: 'Tabs Tour',
      steps: [
        {
          element: '.tabs-header',
          title: 'Video Tabs',
          description: 'Organize your videos into custom collections. Great for grouping related clips, projects, or themes together.',
          side: 'bottom',
        },
        {
          element: '.btn-new-tab',
          title: 'Create New Tab',
          description: 'Click here to create a new tab. Give it a name and optionally add videos right away.',
          side: 'left',
        },
        {
          element: '.tabs-content app-cascade',
          title: 'Your Tabs',
          description: 'Each tab shows as a group. Click the tab header to expand/collapse. Right-click videos to move between tabs or remove them.',
          side: 'top',
        },
      ],
    });

    // Manager tab tour
    this.tours.set('manager', {
      id: 'manager',
      name: 'Manager Tour',
      steps: [
        {
          element: '.manager-container',
          title: 'Library Manager',
          description: 'Maintain your library health. Scan for orphaned files, missing entries, and duplicates.',
          side: 'top',
        },
        {
          element: '.manager-toolbar',
          title: 'Scan Tools',
          description: 'Four scan buttons help you find issues: Orphaned Files (on disk but not in library), Orphaned Entries (in library but file missing), Duplicates (same file twice), and Ignore Patterns (exclude files from scans).',
          side: 'bottom',
        },
        {
          element: '.manager-content',
          title: 'Scan Results',
          description: 'After scanning, results appear here grouped by type. Select items and right-click to take action: add orphaned files to library, remove dead entries, or delete duplicates.',
          side: 'top',
        },
      ],
    });

    // Saved for Later tab tour
    this.tours.set('saved', {
      id: 'saved',
      name: 'Saved for Later Tour',
      steps: [
        {
          element: '.url-input-container',
          title: 'Save URLs',
          description: 'Paste any video URL here to save it for later. Works with YouTube, Vimeo, Twitter, and many other sites.',
          side: 'bottom',
        },
        {
          element: '.download-checkbox',
          title: 'Auto-Download Option',
          description: 'Check this to immediately download the video when you add it. Leave unchecked to just save the link.',
          side: 'bottom',
        },
        {
          element: '.selected-actions',
          title: 'Batch Actions',
          description: 'Select multiple saved links and add them all to your library and tabs at once.',
          side: 'bottom',
        },
        {
          element: '.links-container',
          title: 'Saved Links List',
          description: 'Your saved links appear here. Each shows the title and thumbnail. Right-click for options like download, open in browser, or delete.',
          side: 'top',
        },
      ],
    });
  }

  // Track the current tour ID for completion callback
  private currentTourId: string | null = null;

  /**
   * Get the driver.js configuration
   */
  private getDriverConfig(): Config {
    return {
      showProgress: true,
      animate: true,
      smoothScroll: true,
      allowClose: true,
      stagePadding: 10,
      stageRadius: 8,
      popoverClass: 'clipchimp-tour-popover',
      onDestroyed: () => {
        const completedTourId = this.currentTourId;
        this.isRunning.set(false);
        this.driverInstance = null;
        this.currentTourId = null;

        // Emit completion signal
        if (completedTourId) {
          this.lastCompletedTour.set(completedTourId);
        }

        // Start pending tour if one is queued
        if (this.pendingTourId) {
          const nextTourId = this.pendingTourId;
          this.pendingTourId = null;
          // Small delay to let the UI settle
          setTimeout(() => {
            this.tryAutoStartTour(nextTourId, 300);
          }, 200);
        }
      },
    };
  }

  /**
   * Convert our tour steps to driver.js format
   */
  private toDriverSteps(steps: TourStep[]): DriveStep[] {
    return steps.map((step) => ({
      element: step.element,
      popover: {
        title: step.title,
        description: step.description,
        side: step.side || 'bottom',
        align: step.align || 'center',
      },
    }));
  }

  /**
   * Start a tour for a specific page
   */
  startTour(pageId: string): void {
    const tour = this.tours.get(pageId);
    if (!tour) {
      console.warn(`No tour defined for page: ${pageId}`);
      return;
    }

    // Filter out steps for elements that don't exist on the page
    const availableSteps = tour.steps.filter((step) => {
      if (!step.element) return true; // Steps without elements are always shown
      return document.querySelector(step.element) !== null;
    });

    if (availableSteps.length === 0) {
      console.warn(`No visible elements found for tour: ${pageId}`);
      return;
    }

    // Destroy any existing tour
    if (this.driverInstance) {
      this.driverInstance.destroy();
    }

    // Track current tour for completion callback
    this.currentTourId = pageId;

    // Create and start the tour
    this.driverInstance = driver(this.getDriverConfig());
    this.isRunning.set(true);

    this.driverInstance.setSteps(this.toDriverSteps(availableSteps));
    this.driverInstance.drive();

    // Mark tour as completed
    this.markTourCompleted(pageId);
  }

  /**
   * Queue a tour to run after the current tour completes
   */
  queueTour(tourId: string): void {
    if (!this.isTourCompleted(tourId)) {
      this.pendingTourId = tourId;
    }
  }

  /**
   * Check if a tour has been completed
   */
  isTourCompleted(pageId: string): boolean {
    const completed = this.getCompletedTours();
    return completed.includes(pageId);
  }

  /**
   * Mark a tour as completed
   */
  private markTourCompleted(pageId: string): void {
    const completed = this.getCompletedTours();
    if (!completed.includes(pageId)) {
      completed.push(pageId);
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(completed));
    }
  }

  /**
   * Get list of completed tour IDs
   */
  private getCompletedTours(): string[] {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  /**
   * Reset all tour completion status
   */
  resetAllTours(): void {
    localStorage.removeItem(this.STORAGE_KEY);
  }

  /**
   * Get available tour for current route
   */
  getTourForRoute(route: string): PageTour | null {
    // Map routes to tour IDs
    if (route.includes('/library') || route === '/') {
      return this.tours.get('library') || null;
    }
    if (route.includes('/settings')) {
      return this.tours.get('settings') || null;
    }
    if (route.includes('/video/')) {
      return this.tours.get('video-editor') || null;
    }
    return null;
  }

  /**
   * Check if current page has a tour available
   */
  hasTourForRoute(route: string): boolean {
    return this.getTourForRoute(route) !== null;
  }

  /**
   * Stop the current tour
   */
  stopTour(): void {
    if (this.driverInstance) {
      this.driverInstance.destroy();
      this.driverInstance = null;
      this.isRunning.set(false);
    }
  }

  /**
   * Try to auto-start a tour if user hasn't seen it before.
   * Returns true if tour was started, false otherwise.
   * Uses a small delay to ensure DOM elements are ready.
   */
  tryAutoStartTour(tourId: string, delayMs: number = 500): boolean {
    if (this.isTourCompleted(tourId)) {
      return false;
    }

    // Don't start if another tour is already running
    if (this.isRunning()) {
      return false;
    }

    // Delay to ensure DOM is ready
    setTimeout(() => {
      // Double-check tour hasn't been completed and isn't running
      if (!this.isTourCompleted(tourId) && !this.isRunning()) {
        this.startTour(tourId);
      }
    }, delayMs);

    return true;
  }

  /**
   * Get a tour by ID directly
   */
  getTour(tourId: string): PageTour | null {
    return this.tours.get(tourId) || null;
  }
}
