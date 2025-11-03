// clippy/electron/utilities/whisper-setup-wizard.ts
import { dialog, shell } from 'electron';
import * as child_process from 'child_process';
import * as log from 'electron-log';

/**
 * Whisper setup result
 */
export interface WhisperSetupResult {
  installed: boolean;
  skipped: boolean;
  error?: string;
}

/**
 * Wizard for guiding users through Whisper setup
 */
export class WhisperSetupWizard {

  /**
   * Check if Python is installed
   */
  private async checkPythonInstalled(): Promise<{ installed: boolean; version?: string }> {
    try {
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      const output = child_process.execSync(`${pythonCmd} --version`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return { installed: true, version: output.trim() };
    } catch {
      return { installed: false };
    }
  }

  /**
   * Check if Whisper is installed
   */
  private async checkWhisperInstalled(): Promise<boolean> {
    try {
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      child_process.execSync(`${pythonCmd} -c "import whisper"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Show welcome dialog for Whisper features
   */
  async showWelcomeDialog(): Promise<boolean> {
    const response = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Set Up Whisper', 'Skip for Now', 'Learn More'],
      defaultId: 0,
      cancelId: 1,
      title: 'Audio Transcription Available',
      message: 'Add Audio Transcription with Whisper',
      detail: 'Clippy can transcribe audio from videos using OpenAI Whisper.\n\n' +
        'Features:\n' +
        '• Automatic audio transcription\n' +
        '• Multiple language support\n' +
        '• High accuracy speech-to-text\n' +
        '• Subtitle generation\n\n' +
        'Requirements:\n' +
        '• Python 3.8 or higher\n' +
        '• ~3 GB disk space for models\n' +
        '• FFmpeg (already included)\n\n' +
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
   * Show detailed information about Whisper
   */
  private async showDetailedInfo(): Promise<void> {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      title: 'About Whisper Transcription',
      message: 'How Audio Transcription Works',
      detail: 'What is Whisper?\n' +
        'Whisper is OpenAI\'s automatic speech recognition system. ' +
        'It\'s trained on diverse audio and can transcribe in multiple languages.\n\n' +
        'Features:\n' +
        '• Transcribe videos to text\n' +
        '• Generate subtitles/captions\n' +
        '• Multilingual support (99+ languages)\n' +
        '• Works offline after setup\n\n' +
        'Privacy:\n' +
        'Transcription happens locally on your computer. ' +
        'No audio is sent to external servers.\n\n' +
        'Performance:\n' +
        'Processing time depends on video length and your computer\'s speed. ' +
        'A GPU can significantly speed up transcription.',
      noLink: true
    });
  }

  /**
   * Install Python if not present
   */
  private async installPython(): Promise<boolean> {
    const response = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Open Download Page', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Python Required',
      message: 'Install Python',
      detail: 'Python is required for audio transcription.\n\n' +
        'Steps:\n' +
        '1. Click "Open Download Page" to visit python.org\n' +
        '2. Download Python 3.11 or newer for Windows\n' +
        '3. Run the installer\n' +
        '4. IMPORTANT: Check "Add Python to PATH" during installation\n' +
        '5. Restart Clippy after installation\n\n' +
        'After installing Python, return here and click "Check Again".',
      noLink: true
    });

    if (response.response === 0) {
      // Open Python website
      await shell.openExternal('https://www.python.org/downloads/');

      // Wait for user to install and confirm
      const checkResponse = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Check Again', 'I\'ll Install Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Check Installation',
        message: 'Have you installed Python?',
        detail: 'After installing Python (and checking "Add to PATH"), ' +
          'click "Check Again" to continue setup.\n\n' +
          'Note: You may need to restart your computer for PATH changes to take effect.',
        noLink: true
      });

      if (checkResponse.response === 0) {
        // Check again
        const pythonCheck = await this.checkPythonInstalled();
        if (pythonCheck.installed) {
          await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            title: 'Python Detected',
            message: 'Python is now installed!',
            detail: `Found: ${pythonCheck.version}\n\nContinuing with Whisper installation...`,
            noLink: true
          });
          return true;
        } else {
          await dialog.showMessageBox({
            type: 'error',
            buttons: ['OK'],
            title: 'Python Not Found',
            message: 'Could not detect Python',
            detail: 'Please ensure:\n' +
              '1. Python is installed\n' +
              '2. "Add Python to PATH" was checked during installation\n' +
              '3. You\'ve restarted your terminal/computer\n\n' +
              'You can set up Whisper later from the Settings menu.',
            noLink: true
          });
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Install Whisper package
   */
  private async installWhisperPackage(): Promise<boolean> {
    log.info('Installing Whisper package...');

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    // Show progress dialog
    const progressDialog = dialog.showMessageBox({
      type: 'info',
      buttons: [],
      title: 'Installing Whisper',
      message: 'Installing audio transcription...',
      detail: 'This may take a few minutes. Please wait...\n\n' +
        'Installing: openai-whisper and dependencies'
    });

    try {
      // Install openai-whisper package
      child_process.execSync(`${pythonCmd} -m pip install --upgrade pip`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000 // 2 minutes
      });

      child_process.execSync(`${pythonCmd} -m pip install openai-whisper`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300000 // 5 minutes
      });

      log.info('Whisper installed successfully');

      await dialog.showMessageBox({
        type: 'info',
        buttons: ['OK'],
        title: 'Installation Complete',
        message: 'Whisper Installed Successfully!',
        detail: 'Audio transcription is now available in Clippy.\n\n' +
          'You can transcribe videos from the Video Analysis section.\n\n' +
          'Note: The first transcription will download the AI model (~3 GB) ' +
          'which may take some time depending on your internet speed.',
        noLink: true
      });

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error('Failed to install Whisper:', errorMsg);

      await dialog.showMessageBox({
        type: 'error',
        buttons: ['OK'],
        title: 'Installation Failed',
        message: 'Could not install Whisper',
        detail: `Error: ${errorMsg}\n\n` +
          'You can try installing manually:\n' +
          '1. Open Command Prompt\n' +
          '2. Run: python -m pip install openai-whisper\n\n' +
          'Or set up Whisper later from the Settings menu.',
        noLink: true
      });

      return false;
    }
  }

  /**
   * Run the complete Whisper setup wizard
   */
  async runWizard(): Promise<WhisperSetupResult> {
    const result: WhisperSetupResult = {
      installed: false,
      skipped: false
    };

    // Step 1: Check if Whisper is already installed
    const whisperInstalled = await this.checkWhisperInstalled();
    if (whisperInstalled) {
      log.info('Whisper is already installed');
      result.installed = true;
      return result;
    }

    // Step 2: Show welcome and ask if user wants Whisper
    const wantsWhisper = await this.showWelcomeDialog();

    if (!wantsWhisper) {
      result.skipped = true;
      log.info('User skipped Whisper setup');
      return result;
    }

    // Step 3: Check if Python is installed
    const pythonCheck = await this.checkPythonInstalled();

    if (!pythonCheck.installed) {
      // Need to install Python first
      const pythonInstalled = await this.installPython();
      if (!pythonInstalled) {
        result.skipped = true;
        result.error = 'Python installation required';
        return result;
      }
    } else {
      log.info(`Python detected: ${pythonCheck.version}`);
    }

    // Step 4: Install Whisper package
    const installed = await this.installWhisperPackage();
    result.installed = installed;

    if (!installed) {
      result.error = 'Failed to install Whisper package';
    }

    return result;
  }
}
