#!/usr/bin/env node

/**
 * Python Configuration Verification Script
 *
 * Run this script to verify that Python is properly configured across
 * both the Electron and Backend parts of Clippy.
 *
 * Usage: node scripts/verify-python-setup.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║   Clippy Python Configuration Verification                ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

let allPassed = true;

// Test 1: Verify files exist
console.log('📁 Test 1: Verifying configuration files exist...');
const filesToCheck = [
  'backend/dist/shared/python-config.js',
  'electron/shared/python-config.ts',
  'backend/src/shared/python-config.ts'
];

for (const file of filesToCheck) {
  const fullPath = path.join(__dirname, '..', file);
  if (fs.existsSync(fullPath)) {
    console.log(`   ✓ ${file}`);
  } else {
    console.log(`   ✗ ${file} - MISSING!`);
    allPassed = false;
  }
}
console.log('');

// Test 2: Load backend config
console.log('🐍 Test 2: Loading Python configuration from backend...');
try {
  const backendConfig = require('../backend/dist/shared/python-config');

  const config = backendConfig.getPythonConfig();
  console.log(`   Python Command: ${config.command}`);
  console.log(`   Is Conda: ${config.isConda}`);
  console.log(`   Full Path: ${config.fullPath || 'N/A'}`);

  // Check if Python exists
  try {
    const version = execSync(`${config.command} --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`   ✓ Python found: ${version.trim()}`);
  } catch (e) {
    console.log(`   ✗ Python NOT found at: ${config.command}`);
    allPassed = false;
  }
} catch (e) {
  console.log(`   ✗ Failed to load backend config: ${e.message}`);
  allPassed = false;
}
console.log('');

// Test 3: Validate Python config
console.log('✅ Test 3: Validating Python installation...');
try {
  const backendConfig = require('../backend/dist/shared/python-config');

  backendConfig.validatePythonConfig().then(validation => {
    if (validation.valid) {
      console.log(`   ✓ Valid: true`);
      console.log(`   Version: ${validation.version}`);
    } else {
      console.log(`   ✗ Valid: false`);
      console.log(`   Error: ${validation.error}`);
      allPassed = false;
    }

    // Test 4: Check packages
    console.log('');
    console.log('📦 Test 4: Checking required Python packages...');
    return backendConfig.checkPythonPackages(['whisper', 'requests', 'openai', 'anthropic']);
  }).then(packages => {
    for (const [pkg, installed] of Object.entries(packages)) {
      if (installed) {
        console.log(`   ✓ ${pkg.padEnd(15)} - Installed`);
      } else {
        console.log(`   ✗ ${pkg.padEnd(15)} - NOT INSTALLED`);
        if (pkg === 'whisper' || pkg === 'requests') {
          allPassed = false; // Required packages
        }
      }
    }

    // Test 5: Check Python bridge can execute
    console.log('');
    console.log('🔗 Test 5: Testing Python bridge execution...');

    const pythonScript = path.join(__dirname, '..', 'backend', 'python', 'video_analysis_service.py');
    if (!fs.existsSync(pythonScript)) {
      console.log(`   ✗ Python script not found: ${pythonScript}`);
      allPassed = false;
    } else {
      console.log(`   ✓ Python script found: ${pythonScript}`);

      // Try to execute a simple dependency check
      const { spawn } = require('child_process');
      const config = backendConfig.getPythonConfig();

      console.log(`   Testing execution with: ${config.command}...`);

      const proc = spawn(config.command, [pythonScript]);

      proc.stdin.write(JSON.stringify({ command: 'check_dependencies' }));
      proc.stdin.end();

      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            const lines = output.trim().split('\n');
            const result = JSON.parse(lines[lines.length - 1]);

            if (result.type === 'result' && result.data.whisper && result.data.requests) {
              console.log('   ✓ Python bridge execution successful');
              console.log('   ✓ Whisper module accessible');
              console.log('   ✓ Requests module accessible');
            } else {
              console.log('   ✗ Python modules not accessible via bridge');
              allPassed = false;
            }
          } catch (e) {
            console.log(`   ✗ Failed to parse bridge response: ${e.message}`);
            allPassed = false;
          }
        } else {
          console.log(`   ✗ Python bridge exited with code ${code}`);
          allPassed = false;
        }

        // Final summary
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        if (allPassed) {
          console.log('║   ✓ ALL TESTS PASSED                                      ║');
          console.log('║   Python configuration is correct and consistent!          ║');
        } else {
          console.log('║   ✗ SOME TESTS FAILED                                     ║');
          console.log('║   Please review the errors above                           ║');
        }
        console.log('╚════════════════════════════════════════════════════════════╝\n');

        process.exit(allPassed ? 0 : 1);
      });
    }
  }).catch(err => {
    console.error('\n✗ Unexpected error:', err);
    process.exit(1);
  });
} catch (e) {
  console.log(`   ✗ Failed to run validation: ${e.message}`);
  allPassed = false;
  process.exit(1);
}
