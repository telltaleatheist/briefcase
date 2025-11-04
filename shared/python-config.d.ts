export interface PythonConfig {
    command: string;
    version?: string;
    isConda: boolean;
    fullPath?: string;
}
export declare function getPythonConfig(): PythonConfig;
export declare function getPythonCommand(): string;
export declare function checkPythonPackages(packages: string[]): Promise<Record<string, boolean>>;
export declare function getPythonVersion(): Promise<string | null>;
export declare function validatePythonConfig(): Promise<{
    valid: boolean;
    command: string;
    version: string | null;
    error?: string;
}>;
