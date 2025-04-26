const fs = require('fs');
const path = require('path');

const resourcesPath = path.join(__dirname, '../node_modules/electron/dist/Electron.app/Contents/Resources');
const targetBinPath = path.join(resourcesPath, 'bin');
const sourceBinPath = path.join(__dirname, '../bin');

if (!fs.existsSync(resourcesPath)) {
  console.error('❌ Electron resources path not found. Did you install Electron?');
  process.exit(1);
}

fse.copySync(sourceBinPath, targetBinPath);
console.log(`✅ Copied bin/ to: ${targetBinPath}`);
