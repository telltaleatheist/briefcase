// Save as scripts/quick-analyze.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Directory to analyze
const targetDir = path.join(process.cwd(), 'backend', 'node_modules');

console.log(`Quick analysis of: ${targetDir}`);
console.log('='.repeat(50));

// Use du command on macOS/Linux for faster directory size calculation
try {
  console.log('Top 20 largest directories (this may take a moment)...');
  
  // For macOS/Linux
  if (process.platform !== 'win32') {
    const output = execSync(`du -h -d 2 "${targetDir}" | sort -hr | head -20`, { encoding: 'utf8' });
    console.log(output);
  } 
  // For Windows (less efficient)
  else {
    console.log('On Windows, using slower directory scan method...');
    // Simple scan of top-level directories
    const dirs = fs.readdirSync(targetDir)
      .filter(name => {
        const fullPath = path.join(targetDir, name);
        return fs.statSync(fullPath).isDirectory();
      });
    
    console.log(`Found ${dirs.length} top-level packages`);
    console.log('Run the full analysis script for more details');
  }
  
  // Add suggestion for what to do next
  console.log('\nRecommendation:');
  console.log('Try packaging with the minimal configuration that only includes essential dependencies.');
  console.log('See the "minimal-packaging" artifact for details.');
  
} catch (error) {
  console.error('Error during analysis:', error.message);
}