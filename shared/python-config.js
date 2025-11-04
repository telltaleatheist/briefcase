"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPythonConfig = getPythonConfig;
exports.getPythonCommand = getPythonCommand;
exports.checkPythonPackages = checkPythonPackages;
exports.getPythonVersion = getPythonVersion;
exports.validatePythonConfig = validatePythonConfig;
const fs = require("fs");
function getPythonConfig() {
    const platform = process.platform;
    if (platform === 'darwin') {
        const condaEnvPath = '/opt/homebrew/Caskroom/miniconda/base/envs/metadata-generator/bin/python';
        if (fs.existsSync(condaEnvPath)) {
            return {
                command: condaEnvPath,
                isConda: true,
                fullPath: condaEnvPath,
            };
        }
        return {
            command: 'python3',
            isConda: false,
        };
    }
    if (platform === 'win32') {
        return {
            command: 'python',
            isConda: false,
        };
    }
    return {
        command: 'python3',
        isConda: false,
    };
}
function getPythonCommand() {
    return getPythonConfig().command;
}
async function checkPythonPackages(packages) {
    const { execSync } = require('child_process');
    const pythonCmd = getPythonCommand();
    const results = {};
    for (const pkg of packages) {
        try {
            execSync(`${pythonCmd} -c "import ${pkg}"`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            results[pkg] = true;
        }
        catch {
            results[pkg] = false;
        }
    }
    return results;
}
async function getPythonVersion() {
    const { execSync } = require('child_process');
    const pythonCmd = getPythonCommand();
    try {
        const output = execSync(`${pythonCmd} --version`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return output.trim();
    }
    catch {
        return null;
    }
}
async function validatePythonConfig() {
    const pythonCmd = getPythonCommand();
    const version = await getPythonVersion();
    if (!version) {
        return {
            valid: false,
            command: pythonCmd,
            version: null,
            error: `Python command '${pythonCmd}' not found or not executable`,
        };
    }
    return {
        valid: true,
        command: pythonCmd,
        version,
    };
}
//# sourceMappingURL=python-config.js.map