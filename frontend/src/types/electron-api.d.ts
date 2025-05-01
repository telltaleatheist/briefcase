interface ElectronAPI {
  checkPathConfig: () => Promise<{ isValid: boolean }>;
  getPathConfig: () => Promise<any>;
  updatePathConfig: (config: any) => Promise<{ success: boolean }>;
  showPathConfigDialog: () => Promise<boolean>;
  exitApp: () => void;
  openExternal: (url: string) => Promise<void>;
}

interface Window {
  electronAPI: ElectronAPI;
}
