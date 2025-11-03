// clippy/electron/services/setup-service.ts
import { BrowserWindow, app, dialog } from 'electron';
import * as log from 'electron-log';
import * as path from 'path';
import Store from 'electron-store';
import { DependencyChecker, DependencyCheckResult } from '../utilities/dependency-checker';
import { DependencyInstaller, BatchInstallResult } from '../utilities/dependency-installer';
import { PortableDependencyManager } from '../utilities/portable-dependency-manager';
import { AISetupWizard } from '../utilities/ai-setup-wizard';
import { WhisperSetupWizard } from '../utilities/whisper-setup-wizard';

/**
 * Service for handling first-run setup and dependency installation
 */
export class SetupService {
  private setupWindow: BrowserWindow | null = null;
  private checker: DependencyChecker;
  private installer: DependencyInstaller | null = null;
  private portableManager: PortableDependencyManager;
  private aiWizard: AISetupWizard;
  private whisperWizard: WhisperSetupWizard;
  private store: Store<Record<string, any>>;

  constructor() {
    this.checker = new DependencyChecker();
    this.portableManager = new PortableDependencyManager();
    this.aiWizard = new AISetupWizard();
    this.whisperWizard = new WhisperSetupWizard();
    this.store = new Store<Record<string, any>>();
  }

  /**
   * Check if this is the first run
   */
  isFirstRun(): boolean {
    // You could check a config file or electron-store for a flag
    // For now, we'll always check dependencies
    return true;
  }

  /**
   * Run the setup process
   * Returns true if setup completed successfully, false otherwise
   */
  async runSetup(): Promise<boolean> {
    log.info('Starting setup process...');

    // Check all dependencies
    const checkResult = await this.checker.checkAll();

    // If all dependencies are installed, we're done
    if (checkResult.allInstalled) {
      log.info('All dependencies are already installed');
      return true;
    }

    // Create installer with detected package manager
    this.installer = new DependencyInstaller(checkResult.packageManagerAvailable);

    // Show setup window with progress
    this.createSetupWindow();

    // Ask user for permission to install
    const userApproved = await this.installer.askUserPermission(checkResult.missing);

    if (!userApproved) {
      log.info('User declined dependency installation');
      this.closeSetupWindow();
      return false;
    }

    // Check if we need elevation
    if (checkResult.packageManagerAvailable !== 'none' && !DependencyInstaller.isElevated()) {
      log.warn('Application needs elevation for installation');
      const shouldElevate = await DependencyInstaller.requestElevation();

      if (shouldElevate) {
        // User agreed to restart with elevation
        // This would require implementing elevation logic
        log.info('Restart with elevation requested (not implemented yet)');
      }

      this.closeSetupWindow();
      return false;
    }

    // Install dependencies with progress updates
    const installResult = await this.installer.installDependencies(
      checkResult.missing,
      (progress) => {
        this.sendProgressToWindow(progress);
      }
    );

    // Show results
    await this.installer.showResults(installResult);

    // Close setup window
    this.closeSetupWindow();

    // If installation was successful, verify dependencies again
    if (installResult.allSuccessful) {
      const recheckResult = await this.checker.checkAll();
      return recheckResult.allInstalled;
    }

    return false;
  }

  /**
   * Create the setup window
   */
  private createSetupWindow(): void {
    if (this.setupWindow) {
      return;
    }

    this.setupWindow = new BrowserWindow({
      width: 600,
      height: 400,
      title: 'Clippy Setup',
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload.js')
      }
    });

    // Load setup HTML
    const setupHtmlPath = path.join(__dirname, '../../assets/setup.html');
    this.setupWindow.loadFile(setupHtmlPath).catch(err => {
      log.error('Failed to load setup window:', err);
      // Fallback: show basic message
      this.setupWindow?.loadURL(`data:text/html;charset=utf-8,
        <html>
          <head>
            <title>Clippy Setup</title>
            <style>
              body {
                font-family: system-ui, -apple-system, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: #f5f5f5;
              }
              .container {
                text-align: center;
                padding: 40px;
                background: white;
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              }
              h1 { color: #333; }
              p { color: #666; }
              .spinner {
                border: 4px solid #f3f3f3;
                border-top: 4px solid #3498db;
                border-radius: 50%;
                width: 40px;
                height: 40px;
                animation: spin 1s linear infinite;
                margin: 20px auto;
              }
              @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>Setting up Clippy</h1>
              <div class="spinner"></div>
              <p id="status">Installing dependencies...</p>
            </div>
          </body>
        </html>
      `);
    });

    this.setupWindow.on('closed', () => {
      this.setupWindow = null;
    });
  }

  /**
   * Send progress update to setup window
   */
  private sendProgressToWindow(progress: any): void {
    if (this.setupWindow) {
      this.setupWindow.webContents.send('setup-progress', progress);
    }
  }

  /**
   * Close the setup window
   */
  private closeSetupWindow(): void {
    if (this.setupWindow) {
      this.setupWindow.close();
      this.setupWindow = null;
    }
  }

  /**
   * Get dependency check results without running full setup
   */
  async checkDependencies(): Promise<DependencyCheckResult> {
    return await this.checker.checkAll();
  }

  /**
   * Check if AI setup has been offered before
   */
  private hasOfferedAISetup(): boolean {
    return (this.store as any).get('aiSetupOffered', false) as boolean;
  }

  /**
   * Mark AI setup as offered
   */
  private markAISetupOffered(): void {
    (this.store as any).set('aiSetupOffered', true);
  }

  /**
   * Check if Whisper setup has been offered before
   */
  private hasOfferedWhisperSetup(): boolean {
    return (this.store as any).get('whisperSetupOffered', false) as boolean;
  }

  /**
   * Mark Whisper setup as offered
   */
  private markWhisperSetupOffered(): void {
    (this.store as any).set('whisperSetupOffered', true);
  }

  /**
   * Run AI features setup (Ollama) on first launch
   * Returns true if setup completed or was skipped, false if user wants to try later
   */
  async runAISetup(checkResult: DependencyCheckResult): Promise<boolean> {
    // Don't offer if already offered before
    if (this.hasOfferedAISetup()) {
      log.info('AI setup already offered in a previous session');
      return true;
    }

    log.info('Offering AI features setup...');

    try {
      // Determine which package manager to use
      let packageManager: 'chocolatey' | 'scoop' | 'winget' | 'none' = 'none';

      if (process.platform === 'win32') {
        packageManager = checkResult.packageManagerAvailable || 'none';
      }

      // Run the AI setup wizard
      const result = await this.aiWizard.runWizard(packageManager);

      // Mark as offered regardless of outcome
      this.markAISetupOffered();

      if (result.skipped) {
        log.info('User skipped AI setup');
        return true;
      }

      if (result.ollamaInstalled && result.modelInstalled) {
        log.info(`AI setup completed: ${result.modelName}`);
        return true;
      }

      if (result.error) {
        log.error(`AI setup error: ${result.error}`);
        return true; // Continue anyway
      }

      return true;
    } catch (error) {
      log.error('Error during AI setup:', error);
      return true; // Continue anyway
    }
  }

  /**
   * Run Whisper setup on first launch
   * Returns true if setup completed or was skipped
   */
  async runWhisperSetup(): Promise<boolean> {
    // Don't offer if already offered before
    if (this.hasOfferedWhisperSetup()) {
      log.info('Whisper setup already offered in a previous session');
      return true;
    }

    log.info('Offering Whisper transcription setup...');

    try {
      // Run the Whisper setup wizard
      const result = await this.whisperWizard.runWizard();

      // Mark as offered regardless of outcome
      this.markWhisperSetupOffered();

      if (result.skipped) {
        log.info('User skipped Whisper setup');
        return true;
      }

      if (result.installed) {
        log.info('Whisper setup completed successfully');
        return true;
      }

      if (result.error) {
        log.error(`Whisper setup error: ${result.error}`);
        return true; // Continue anyway
      }

      return true;
    } catch (error) {
      log.error('Error during Whisper setup:', error);
      return true; // Continue anyway
    }
  }

  /**
   * Run optional AI features setup after main app is ready
   * This runs after the main window is created so it doesn't block startup
   */
  async runOptionalSetups(checkResult: DependencyCheckResult): Promise<void> {
    log.info('Running optional AI features setup...');

    // Run AI setup first (Ollama)
    await this.runAISetup(checkResult);

    // Then offer Whisper setup
    await this.runWhisperSetup();

    log.info('Optional setups complete');
  }
}
