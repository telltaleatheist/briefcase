interface ElectronAPI {
  checkPathConfig: () => Promise<{ isValid: boolean }>;
  getPathConfig: () => Promise<any>;
  updatePathConfig: (config: any) => Promise<{ success: boolean }>;
  showPathConfigDialog: () => Promise<boolean>;
  exitApp: () => void;
  openExternal: (url: string) => Promise<void>;
  openPath: (path: string) => Promise<string>;
  copyFilesToClipboard: (filePaths: string[]) => Promise<{ success: boolean; error?: string }>;
  openInQuickTime: (filePath: string) => Promise<{ success: boolean; error?: string }>;
}

interface Window {
  electronAPI: ElectronAPI;
}
