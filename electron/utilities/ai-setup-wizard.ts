// clippy/electron/utilities/ai-setup-wizard.ts
import { dialog, BrowserWindow } from 'electron';
import * as child_process from 'child_process';
import * as log from 'electron-log';
import * as path from 'path';

/**
 * AI Model information
 */
export interface AIModelInfo {
  name: string;
  displayName: string;
  description: string;
  size: string;
  estimatedRAM: string;
  capabilities: string[];
  recommended: boolean;
}

/**
 * AI setup result
 */
export interface AISetupResult {
  ollamaInstalled: boolean;
  modelInstalled: boolean;
  modelName?: string;
  skipped: boolean;
  error?: string;
}

/**
 * Progress callback for AI setup
 */
export type AISetupProgressCallback = (progress: {
  stage: 'ollama' | 'model' | 'verification';
  status: 'installing' | 'downloading' | 'success' | 'failed';
  message: string;
  progress?: number; // 0-100 percentage
  error?: string;
}) => void;

/**
 * Wizard for guiding users through AI setup
 */
export class AISetupWizard {
  private wizardWindow: BrowserWindow | null = null;

  /**
   * Get available AI models
   */
  private getAvailableModels(): AIModelInfo[] {
    return [
      {
        name: 'qwen2.5:7b',
        displayName: 'Qwen 2.5 (7B)',
        description: 'A balanced, efficient model perfect for video analysis, content generation, and general tasks. Recommended for most users.',
        size: '~4.7 GB',
        estimatedRAM: '8 GB',
        capabilities: [
          'Video content analysis',
          'Title and description generation',
          'Metadata extraction',
          'Content summarization'
        ],
        recommended: true
      },
      {
        name: 'llama3.2:3b',
        displayName: 'Llama 3.2 (3B)',
        description: 'A lightweight model that runs well on lower-end hardware. Good for basic tasks.',
        size: '~2.0 GB',
        estimatedRAM: '4 GB',
        capabilities: [
          'Basic content analysis',
          'Simple title generation'
        ],
        recommended: false
      },
      {
        name: 'mistral:7b',
        displayName: 'Mistral (7B)',
        description: 'Alternative 7B model with strong performance in creative tasks.',
        size: '~4.1 GB',
        estimatedRAM: '8 GB',
        capabilities: [
          'Creative content generation',
          'Detailed video analysis',
          'Advanced summarization'
        ],
        recommended: false
      }
    ];
  }

  /**
   * Show welcome dialog explaining AI features
   */
  async showWelcomeDialog(): Promise<boolean> {
    const response = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Set Up AI Features', 'Skip for Now', 'Learn More'],
      defaultId: 0,
      cancelId: 1,
      title: 'AI-Powered Features Available',
      message: 'Enhance Clippy with Local AI',
      detail: 'Clippy can use local AI models to:\n\n' +
        '• Analyze video content automatically\n' +
        '• Generate titles and descriptions\n' +
        '• Extract metadata and topics\n' +
        '• Transcribe and analyze audio\n\n' +
        'This requires installing Ollama (free, open-source) and downloading an AI model.\n\n' +
        'Storage required: ~5-8 GB\n' +
        'RAM recommended: 8 GB or more\n\n' +
        'Would you like to set this up now?',
      noLink: true
    });

    if (response.response === 2) {
      // User wants to learn more
      await this.showDetailedInfo();
      // Ask again after showing info
      return await this.showWelcomeDialog();
    }

    return response.response === 0;
  }

  /**
   * Show detailed information about AI features
   */
  private async showDetailedInfo(): Promise<void> {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      title: 'About Local AI Features',
      message: 'How Local AI Works in Clippy',
      detail: 'What is Ollama?\n' +
        'Ollama is a free, open-source tool that lets you run AI models locally on your computer. ' +
        'Your data stays private and never leaves your machine.\n\n' +
        'What is Qwen 2.5?\n' +
        'Qwen 2.5 is a high-quality, efficient AI model developed by Alibaba Cloud. ' +
        'It\'s excellent for understanding video content, generating descriptions, and analyzing media.\n\n' +
        'System Requirements:\n' +
        '• 8+ GB RAM (16 GB recommended)\n' +
        '• ~5-8 GB free disk space\n' +
        '• Modern CPU (GPU optional but helps)\n\n' +
        'Privacy:\n' +
        'Everything runs locally. No data is sent to external servers.\n\n' +
        'Performance:\n' +
        'First-time analysis may take 10-30 seconds. Subsequent analyses are faster.',
      noLink: true
    });
  }

  /**
   * Show model selection dialog
   */
  async selectModel(): Promise<AIModelInfo | null> {
    const models = this.getAvailableModels();
    const recommended = models.find(m => m.recommended);

    if (!recommended) {
      return models[0];
    }

    // Create detailed message
    let message = 'Choose an AI model to install:\n\n';
    message += `RECOMMENDED: ${recommended.displayName}\n`;
    message += `${recommended.description}\n\n`;
    message += `Size: ${recommended.size}\n`;
    message += `RAM Needed: ${recommended.estimatedRAM}\n\n`;
    message += 'Capabilities:\n';
    recommended.capabilities.forEach(cap => {
      message += `  • ${cap}\n`;
    });

    const response = await dialog.showMessageBox({
      type: 'question',
      buttons: [
        `Install ${recommended.displayName} (Recommended)`,
        'Choose Different Model',
        'Cancel'
      ],
      defaultId: 0,
      cancelId: 2,
      title: 'Select AI Model',
      message: 'AI Model Selection',
      detail: message,
      noLink: true
    });

    if (response.response === 2) {
      return null; // User cancelled
    }

    if (response.response === 0) {
      return recommended;
    }

    // Show advanced selection
    return await this.showAdvancedModelSelection(models);
  }

  /**
   * Show advanced model selection with all options
   */
  private async showAdvancedModelSelection(models: AIModelInfo[]): Promise<AIModelInfo | null> {
    let message = 'Available AI Models:\n\n';

    models.forEach((model, index) => {
      message += `${index + 1}. ${model.displayName} ${model.recommended ? '(RECOMMENDED)' : ''}\n`;
      message += `   ${model.description}\n`;
      message += `   Size: ${model.size} | RAM: ${model.estimatedRAM}\n\n`;
    });

    const buttons = models.map(m => m.displayName);
    buttons.push('Cancel');

    const response = await dialog.showMessageBox({
      type: 'question',
      buttons,
      defaultId: 0,
      cancelId: models.length,
      title: 'Select AI Model',
      message: 'Choose Your AI Model',
      detail: message,
      noLink: true
    });

    if (response.response === models.length) {
      return null;
    }

    return models[response.response];
  }

  /**
   * Check available disk space
   */
  private async checkDiskSpace(): Promise<{ available: number; sufficient: boolean }> {
    // This is a simplified check - you'd want to use a proper disk space checker
    // For now, we'll assume sufficient space
    return { available: 10000, sufficient: true };
  }

  /**
   * Check if Ollama is already installed
   */
  private async checkOllamaInstalled(): Promise<boolean> {
    try {
      child_process.execSync('ollama --version', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install Ollama or provide manual installation instructions
   */
  private async installOllama(
    packageManager: 'chocolatey' | 'scoop' | 'winget' | 'none',
    progressCallback?: AISetupProgressCallback
  ): Promise<boolean> {
    log.info('Installing Ollama...');

    // First check if already installed
    const alreadyInstalled = await this.checkOllamaInstalled();
    if (alreadyInstalled) {
      log.info('Ollama is already installed');
      if (progressCallback) {
        progressCallback({
          stage: 'ollama',
          status: 'success',
          message: 'Ollama is already installed'
        });
      }
      return true;
    }

    if (progressCallback) {
      progressCallback({
        stage: 'ollama',
        status: 'installing',
        message: 'Installing Ollama...'
      });
    }

    let command: string | null = null;

    switch (packageManager) {
      case 'chocolatey':
        command = 'choco install ollama -y';
        break;
      case 'scoop':
        command = 'scoop install ollama';
        break;
      case 'winget':
        command = 'winget install Ollama.Ollama --silent';
        break;
      default:
        // No package manager - offer manual installation
        const response = await dialog.showMessageBox({
          type: 'info',
          buttons: ['Open Download Page', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          title: 'Manual Installation Required',
          message: 'Install Ollama',
          detail: 'Ollama needs to be installed manually.\n\n' +
            'Steps:\n' +
            '1. Click "Open Download Page" to visit ollama.ai\n' +
            '2. Download the Windows installer\n' +
            '3. Run the installer\n' +
            '4. Restart Clippy after installation\n\n' +
            'After installing Ollama, return here and click "Check Again".',
          noLink: true
        });

        if (response.response === 0) {
          // Open Ollama website
          require('electron').shell.openExternal('https://ollama.ai/download');

          // Wait for user to install and confirm
          const checkResponse = await dialog.showMessageBox({
            type: 'question',
            buttons: ['Check Again', 'I\'ll Install Later'],
            defaultId: 0,
            cancelId: 1,
            title: 'Check Installation',
            message: 'Have you installed Ollama?',
            detail: 'After installing Ollama, click "Check Again" to continue setup.',
            noLink: true
          });

          if (checkResponse.response === 0) {
            // Check again
            return await this.checkOllamaInstalled();
          }
        }

        if (progressCallback) {
          progressCallback({
            stage: 'ollama',
            status: 'failed',
            message: 'Manual installation required',
            error: 'User needs to install Ollama manually'
          });
        }
        return false;
    }

    try {
      child_process.execSync(command, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300000 // 5 minutes
      });

      log.info('Ollama installed successfully');

      if (progressCallback) {
        progressCallback({
          stage: 'ollama',
          status: 'success',
          message: 'Ollama installed successfully'
        });
      }

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error('Failed to install Ollama:', errorMsg);

      // Offer manual installation as fallback
      const response = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Try Manual Installation', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Automatic Installation Failed',
        message: 'Could not install Ollama automatically',
        detail: `Error: ${errorMsg}\n\n` +
          'Would you like to install manually instead?',
        noLink: true
      });

      if (response.response === 0) {
        return await this.installOllama('none', progressCallback);
      }

      if (progressCallback) {
        progressCallback({
          stage: 'ollama',
          status: 'failed',
          message: 'Failed to install Ollama',
          error: errorMsg
        });
      }

      return false;
    }
  }

  /**
   * Download and install AI model
   */
  private async installModel(
    modelName: string,
    progressCallback?: AISetupProgressCallback
  ): Promise<boolean> {
    log.info(`Installing AI model: ${modelName}`);

    if (progressCallback) {
      progressCallback({
        stage: 'model',
        status: 'downloading',
        message: `Downloading ${modelName}... This may take several minutes.`,
        progress: 0
      });
    }

    try {
      // Pull the model using ollama
      const command = `ollama pull ${modelName}`;

      const process = child_process.spawn('ollama', ['pull', modelName], {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let currentProgress = 0;

      process.stdout?.on('data', (data) => {
        const output = data.toString();
        log.debug('Ollama pull output:', output);

        // Try to parse progress from output
        const progressMatch = output.match(/(\d+)%/);
        if (progressMatch && progressCallback) {
          currentProgress = parseInt(progressMatch[1]);
          progressCallback({
            stage: 'model',
            status: 'downloading',
            message: `Downloading ${modelName}...`,
            progress: currentProgress
          });
        }
      });

      return new Promise((resolve) => {
        process.on('close', (code) => {
          if (code === 0) {
            log.info(`Model ${modelName} installed successfully`);
            if (progressCallback) {
              progressCallback({
                stage: 'model',
                status: 'success',
                message: `${modelName} installed successfully`,
                progress: 100
              });
            }
            resolve(true);
          } else {
            log.error(`Failed to install model ${modelName}, exit code: ${code}`);
            if (progressCallback) {
              progressCallback({
                stage: 'model',
                status: 'failed',
                message: `Failed to install ${modelName}`,
                error: `Exit code: ${code}`
              });
            }
            resolve(false);
          }
        });
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error('Failed to install model:', errorMsg);

      if (progressCallback) {
        progressCallback({
          stage: 'model',
          status: 'failed',
          message: 'Failed to install model',
          error: errorMsg
        });
      }

      return false;
    }
  }

  /**
   * Verify installation
   */
  private async verifyInstallation(modelName: string): Promise<boolean> {
    try {
      // Check if model is available
      const output = child_process.execSync('ollama list', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });

      return output.includes(modelName);
    } catch (error) {
      log.error('Failed to verify installation:', error);
      return false;
    }
  }

  /**
   * Check if user already has any models installed
   */
  private async checkExistingModels(): Promise<string[]> {
    try {
      const output = child_process.execSync('ollama list', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });

      // Parse output to get model names
      const lines = output.split('\n').slice(1); // Skip header
      const models = lines
        .filter(line => line.trim())
        .map(line => line.split(/\s+/)[0])
        .filter(name => name && name !== 'NAME');

      return models;
    } catch (error) {
      log.error('Failed to check existing models:', error);
      return [];
    }
  }

  /**
   * Run the complete AI setup wizard
   */
  async runWizard(
    packageManager: 'chocolatey' | 'scoop' | 'winget' | 'none',
    progressCallback?: AISetupProgressCallback
  ): Promise<AISetupResult> {
    const result: AISetupResult = {
      ollamaInstalled: false,
      modelInstalled: false,
      skipped: false
    };

    // Step 1: Show welcome and ask if user wants AI features
    const wantsAI = await this.showWelcomeDialog();

    if (!wantsAI) {
      result.skipped = true;
      log.info('User skipped AI setup');
      return result;
    }

    // Step 2: Check disk space
    const diskSpace = await this.checkDiskSpace();
    if (!diskSpace.sufficient) {
      await dialog.showMessageBox({
        type: 'warning',
        buttons: ['OK'],
        title: 'Insufficient Disk Space',
        message: 'Not enough disk space available',
        detail: `AI features require at least 8 GB of free disk space.\n` +
          `You currently have ${(diskSpace.available / 1000).toFixed(1)} GB available.\n\n` +
          `Please free up some space and try again later.`
      });
      result.skipped = true;
      return result;
    }

    // Step 3: Install Ollama (or check if already installed)
    const ollamaInstalled = await this.installOllama(packageManager, progressCallback);
    result.ollamaInstalled = ollamaInstalled;

    if (!ollamaInstalled) {
      result.error = 'Failed to install Ollama';
      return result;
    }

    // Step 3.5: Check if user already has models installed
    const existingModels = await this.checkExistingModels();

    if (existingModels.length > 0) {
      log.info(`Found existing models: ${existingModels.join(', ')}`);

      const response = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Use Existing Models', 'Install New Model'],
        defaultId: 0,
        cancelId: 0,
        title: 'Models Already Installed',
        message: 'Ollama Models Detected',
        detail: `You already have ${existingModels.length} model(s) installed:\n\n` +
          existingModels.map(m => `  • ${m}`).join('\n') + '\n\n' +
          'Would you like to use these models or install a new one?',
        noLink: true
      });

      if (response.response === 0) {
        // User wants to use existing models
        result.modelInstalled = true;
        result.modelName = existingModels[0]; // Use first model
        log.info(`User chose to use existing models: ${existingModels[0]}`);

        await dialog.showMessageBox({
          type: 'info',
          buttons: ['OK'],
          title: 'Setup Complete',
          message: 'AI Features Ready!',
          detail: `You can now use AI-powered features in Clippy with your existing models.\n\n` +
            `Available models:\n` + existingModels.map(m => `  • ${m}`).join('\n'),
          noLink: true
        });

        return result;
      }
      // Otherwise, continue to model selection
    }

    // Step 4: Select model
    const selectedModel = await this.selectModel();

    if (!selectedModel) {
      result.skipped = true;
      log.info('User cancelled model selection');
      return result;
    }

    // Step 5: Install model
    const modelInstalled = await this.installModel(selectedModel.name, progressCallback);
    result.modelInstalled = modelInstalled;
    result.modelName = selectedModel.name;

    if (!modelInstalled) {
      result.error = 'Failed to install AI model';
      return result;
    }

    // Step 6: Verify installation
    if (progressCallback) {
      progressCallback({
        stage: 'verification',
        status: 'installing',
        message: 'Verifying installation...'
      });
    }

    const verified = await this.verifyInstallation(selectedModel.name);

    if (verified) {
      if (progressCallback) {
        progressCallback({
          stage: 'verification',
          status: 'success',
          message: 'AI features ready to use!'
        });
      }

      // Show success message
      await dialog.showMessageBox({
        type: 'info',
        buttons: ['OK'],
        title: 'Setup Complete',
        message: 'AI Features Ready!',
        detail: `${selectedModel.displayName} has been successfully installed.\n\n` +
          `You can now use AI-powered features in Clippy:\n` +
          `• Automatic video analysis\n` +
          `• Smart title and description generation\n` +
          `• Content summarization\n\n` +
          `These features will be available in the Video Analysis section.`
      });
    } else {
      if (progressCallback) {
        progressCallback({
          stage: 'verification',
          status: 'failed',
          message: 'Verification failed',
          error: 'Model not found after installation'
        });
      }
      result.error = 'Verification failed';
    }

    return result;
  }
}
