// clippy/electron/utilities/whisper-setup-wizard.ts
import { dialog, shell } from 'electron';
import * as child_process from 'child_process';
import * as log from 'electron-log';
import { getPythonCommand } from '../shared/python-config';

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
   * Get the Python command that will be used at runtime
   * This MUST match what the backend PythonBridgeService uses
   *
   * Now using centralized python-config module to ensure consistency
   */
  private getRuntimePythonCommand(): string {
    const pythonCmd = getPythonCommand();
    log.info(`Using runtime Python command from centralized config: ${pythonCmd}`);
    return pythonCmd;
  }

  /**
   * Check if Python is installed and get version
   */
  private async checkPythonInstalled(): Promise<{ installed: boolean; version?: string; command?: string }> {
    // IMPORTANT: Use the same Python command that the runtime will use
    // This ensures we check and install packages for the correct Python version
    const runtimeCommand = this.getRuntimePythonCommand();

    // Try runtime command first, then fall back to specific versions
    const pythonCommands = process.platform === 'win32'
      ? [runtimeCommand, 'py -3.12', 'py -3.11', 'py -3']
      : [runtimeCommand, 'python3.12', 'python3.11'];

    for (const cmd of pythonCommands) {
      try {
        const output = child_process.execSync(`${cmd} --version`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
        const version = output.trim();

        // Check if version is compatible (3.8-3.13)
        const versionMatch = version.match(/Python (\d+)\.(\d+)/);
        if (versionMatch) {
          const major = parseInt(versionMatch[1]);
          const minor = parseInt(versionMatch[2]);

          if (major === 3 && minor >= 8 && minor <= 12) {
            log.info(`Found compatible Python: ${version} (${cmd})`);
            // If this is the runtime command, prioritize it
            if (cmd === runtimeCommand) {
              log.info(`This matches the runtime Python command - using this one`);
            }
            return { installed: true, version: version, command: cmd };
          } else if (major === 3 && minor >= 13) {
            log.warn(`Found Python ${major}.${minor} which may have compatibility issues. Recommend Python 3.11 or 3.12.`);
            // Still allow it, but warn
            return { installed: true, version: version, command: cmd };
          } else {
            log.warn(`Found incompatible Python: ${version} (need 3.8-3.12)`);
          }
        }
      } catch {
        // Try next command
        continue;
      }
    }

    return { installed: false };
  }

  /**
   * Check if Whisper and AI analysis dependencies are installed
   * Uses the SAME Python command that will be used at runtime
   */
  private async checkWhisperInstalled(): Promise<boolean> {
    // Always check the runtime Python command, not just any Python
    const runtimeCommand = this.getRuntimePythonCommand();

    try {
      // First verify the runtime Python exists
      child_process.execSync(`${runtimeCommand} --version`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });

      log.info(`Checking whisper installation for runtime Python: ${runtimeCommand}`);
    } catch {
      log.warn(`Runtime Python command '${runtimeCommand}' not found`);
      return false;
    }

    try {
      // Check all required packages using the RUNTIME Python command
      const output = child_process.execSync(`${runtimeCommand} -c "import whisper; import requests; print('OK')"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const success = output.trim() === 'OK';
      if (success) {
        log.info(`Whisper is installed for runtime Python: ${runtimeCommand}`);
      }
      return success;
    } catch (error) {
      log.warn(`Whisper not installed for runtime Python '${runtimeCommand}': ${error instanceof Error ? error.message : String(error)}`);
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
      detail: 'Python 3.11 or 3.12 is required for audio transcription.\n\n' +
        'Steps:\n' +
        '1. Click "Open Download Page" to visit python.org\n' +
        '2. Download Python 3.12 (recommended) for Windows\n' +
        '3. Run the installer\n' +
        '4. IMPORTANT: Check "Add Python to PATH" during installation\n' +
        '5. Restart Clippy after installation\n\n' +
        'Note: Python 3.14 is NOT compatible. Use Python 3.11 or 3.12.\n\n' +
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
   * Show progress window for pip installation
   */
  private showProgressWindow(title: string, message: string): Electron.BrowserWindow {
    const { BrowserWindow } = require('electron');

    const progressWindow = new BrowserWindow({
      width: 600,
      height: 400,
      title: title,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .container {
              width: 90%;
              max-width: 500px;
              background: white;
              border-radius: 12px;
              padding: 30px;
              box-shadow: 0 4px 16px rgba(0,0,0,0.1);
            }
            h2 {
              margin: 0 0 20px 0;
              color: #333;
              font-size: 20px;
              font-weight: 600;
            }
            .status {
              color: #666;
              margin-bottom: 20px;
              font-size: 14px;
              line-height: 1.6;
            }
            .console {
              background: #1e1e1e;
              color: #d4d4d4;
              padding: 15px;
              border-radius: 6px;
              font-family: 'Consolas', 'Monaco', monospace;
              font-size: 12px;
              max-height: 200px;
              overflow-y: auto;
              white-space: pre-wrap;
              word-wrap: break-word;
            }
            .spinner {
              display: inline-block;
              width: 14px;
              height: 14px;
              border: 2px solid #f3f3f3;
              border-top: 2px solid #3498db;
              border-radius: 50%;
              animation: spin 1s linear infinite;
              margin-right: 8px;
              vertical-align: middle;
            }
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
            .step {
              color: #3498db;
              font-weight: 600;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>${message}</h2>
            <div class="status">
              <div class="spinner"></div>
              <span class="step" id="currentStep">Starting...</span>
            </div>
            <div class="console" id="console">Initializing pip installation...</div>
          </div>
          <script>
            const { ipcRenderer } = require('electron');
            const consoleEl = document.getElementById('console');
            const stepEl = document.getElementById('currentStep');

            ipcRenderer.on('pip-output', (event, data) => {
              consoleEl.textContent += data + '\\n';
              consoleEl.scrollTop = consoleEl.scrollHeight;
            });

            ipcRenderer.on('pip-step', (event, step) => {
              stepEl.textContent = step;
            });
          </script>
        </body>
      </html>
    `;

    progressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    progressWindow.once('ready-to-show', () => {
      progressWindow.show();
    });

    return progressWindow;
  }

  /**
   * Run pip install command with progress updates
   */
  private async runPipInstallWithProgress(
    pythonCmd: string,
    packages: string,
    stepName: string,
    progressWindow: Electron.BrowserWindow,
    timeoutMs: number = 600000
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      log.info(`Installing: ${packages}`);
      progressWindow.webContents.send('pip-step', stepName);

      const { spawn } = child_process;
      const args = ['-m', 'pip', 'install', ...packages.split(' ')];
      const process = spawn(pythonCmd, args);

      let outputBuffer = '';
      let errorBuffer = '';

      const timeout = setTimeout(() => {
        process.kill();
        reject(new Error(`Installation timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      process.stdout?.on('data', (data) => {
        const text = data.toString();
        outputBuffer += text;

        // Send to progress window
        progressWindow.webContents.send('pip-output', text.trim());

        // Log important lines
        if (text.includes('Downloading') || text.includes('Installing') || text.includes('Successfully')) {
          log.info(text.trim());
        }
      });

      process.stderr?.on('data', (data) => {
        const text = data.toString();
        errorBuffer += text;

        // Send to progress window (stderr often has progress info for pip)
        progressWindow.webContents.send('pip-output', text.trim());

        // Only log errors, not warnings
        if (text.includes('ERROR') || text.includes('error:')) {
          log.error(text.trim());
        }
      });

      process.on('close', (code) => {
        clearTimeout(timeout);

        if (code === 0) {
          progressWindow.webContents.send('pip-output', `✓ ${stepName} completed successfully`);
          resolve(true);
        } else {
          const errorMsg = errorBuffer || outputBuffer || 'Unknown error';
          reject(new Error(`pip install failed with code ${code}: ${errorMsg}`));
        }
      });

      process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Install Whisper package and AI analysis dependencies
   */
  private async installWhisperPackage(): Promise<boolean> {
    log.info('Installing Whisper and AI analysis dependencies...');

    // Get the compatible Python command
    const pythonCheck = await this.checkPythonInstalled();
    if (!pythonCheck.installed || !pythonCheck.command) {
      await dialog.showMessageBox({
        type: 'error',
        buttons: ['OK'],
        title: 'Python Not Found',
        message: 'Compatible Python version not found',
        detail: 'OpenAI Whisper requires Python 3.8-3.12.\n\n' +
          'Recommended: Python 3.11 or 3.12\n\n' +
          'Please install from:\n' +
          'https://www.python.org/downloads/\n\n' +
          'Make sure to check "Add Python to PATH" during installation.',
        noLink: true
      });
      return false;
    }

    const pythonCmd = pythonCheck.command;
    log.info(`Using Python command: ${pythonCmd} (${pythonCheck.version})`);

    // Show progress window
    const progressWindow = this.showProgressWindow(
      'Installing Python Packages',
      'Installing AI and transcription packages...'
    );

    try {
      // Determine numpy/torch versions based on Python version
      const pythonVersion = pythonCheck.version || '';
      const isOldPython = pythonVersion.includes('3.8') || pythonVersion.includes('3.9');

      const numpyVersion = isOldPython ? '1.24.4' : '1.26.4';
      const torchVersion = isOldPython ? '2.0.1' : '2.1.2';
      const torchaudioVersion = isOldPython ? '2.0.2' : '2.1.2';

      log.info(`Python ${pythonVersion}: using numpy==${numpyVersion}, torch==${torchVersion}`);

      // Step 1: Upgrade pip (2 min timeout)
      await this.runPipInstallWithProgress(
        pythonCmd,
        '--upgrade pip',
        'Step 1/4: Upgrading pip...',
        progressWindow,
        120000
      );

      // Step 2: Install numpy and torch (10 min timeout - torch is ~200MB)
      await this.runPipInstallWithProgress(
        pythonCmd,
        `numpy==${numpyVersion} torch==${torchVersion} torchaudio==${torchaudioVersion}`,
        'Step 2/4: Installing PyTorch and NumPy (this may take 5-10 minutes)...',
        progressWindow,
        600000
      );

      // Step 3: Install whisper and requests (10 min timeout)
      await this.runPipInstallWithProgress(
        pythonCmd,
        'openai-whisper==20231117 requests==2.31.0',
        'Step 3/4: Installing OpenAI Whisper...',
        progressWindow,
        600000
      );

      // Step 4: Install optional packages (2 min timeout, non-blocking)
      try {
        await this.runPipInstallWithProgress(
          pythonCmd,
          'openai anthropic',
          'Step 4/4: Installing optional AI providers...',
          progressWindow,
          120000
        );
        log.info('Optional AI packages installed successfully');
      } catch (optionalError) {
        log.warn('Optional AI packages failed to install (non-critical):', optionalError);
        progressWindow.webContents.send('pip-output', '⚠ Optional packages skipped (non-critical)');
      }

      // Close progress window
      progressWindow.close();

      log.info('All Python packages installed successfully');

      await dialog.showMessageBox({
        type: 'info',
        buttons: ['OK'],
        title: 'Installation Complete',
        message: 'Python Packages Installed Successfully!',
        detail: 'Audio transcription and AI analysis are now available in Clippy.\n\n' +
          'Installed packages:\n' +
          '✓ openai-whisper - Audio transcription\n' +
          '✓ requests - HTTP communication\n' +
          '✓ openai - GPT models support\n' +
          '✓ anthropic - Claude API support\n\n' +
          'Note: The first transcription will download the Whisper AI model (~3 GB) ' +
          'which may take some time depending on your internet speed.',
        noLink: true
      });

      return true;
    } catch (error) {
      // Close progress window on error
      if (!progressWindow.isDestroyed()) {
        progressWindow.close();
      }

      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error('Failed to install Python packages:', errorMsg);

      await dialog.showMessageBox({
        type: 'error',
        buttons: ['OK'],
        title: 'Installation Failed',
        message: 'Could not install Python packages',
        detail: `Error: ${errorMsg}\n\n` +
          'You can try installing manually:\n' +
          '1. Install Python 3.11 or 3.12 from python.org (recommended)\n' +
          '2. Open Command Prompt or Terminal\n' +
          '3. For Python 3.11/3.12:\n' +
          '   Windows: py -3.12 -m pip install numpy==1.26.4 torch==2.1.2\n' +
          '   Mac/Linux: python3.12 -m pip install numpy==1.26.4 torch==2.1.2\n' +
          '   For Python 3.8/3.9: Use numpy==1.24.4 torch==2.0.1 instead\n' +
          '4. Run: python -m pip install openai-whisper==20231117 requests==2.31.0\n' +
          '5. Optional: python -m pip install openai anthropic\n\n' +
          'Or set up packages later from the Settings menu.',
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
