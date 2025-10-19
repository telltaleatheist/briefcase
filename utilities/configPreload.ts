// utilities/configPreload.ts
import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld(
  'electronAPI',
  {
    // Dialog handlers for executable selection
    selectExecutable: (executableType: string) => {
      return ipcRenderer.invoke('select-executable', executableType);
    },

    // Select a directory containing all executables
    selectExecutablesDirectory: () => {
      return ipcRenderer.invoke('select-executables-directory');
    },

    // Auto-detect executables in PATH
    autoDetectExecutables: () => {
      return ipcRenderer.invoke('auto-detect-executables');
    },

    // Check if config is valid
    checkConfig: () => {
      return ipcRenderer.invoke('check-config');
    },

    // Get current configuration
    getConfig: () => {
      return ipcRenderer.invoke('get-config');
    },

    // Save configuration
    saveConfig: (config: any) => {
      return ipcRenderer.invoke('save-config', config);
    },

    // Notify that config has been saved successfully
    configSaved: () => {
      ipcRenderer.send('config-saved');
    },

    // Exit the application
    exitApp: () => {
      ipcRenderer.send('exit-app');
    }
  }
);