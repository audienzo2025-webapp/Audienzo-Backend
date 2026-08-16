const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 Starting robust Angular build process...');

// Check Node.js version
const nodeVersion = process.version;
console.log(`📋 Node.js version: ${nodeVersion}`);

// Navigate to Angular app directory
const angularAppPath = path.join(__dirname, '../audienzo-app');
console.log(`📁 Angular app path: ${angularAppPath}`);

if (!fs.existsSync(angularAppPath)) {
  console.error('❌ Angular app directory not found');
  process.exit(1);
}

try {
  // Change to Angular app directory
  process.chdir(angularAppPath);
  console.log('📂 Changed to Angular app directory');
  
  // Install dependencies with legacy peer deps and ignore engine warnings
  console.log('📦 Installing dependencies with legacy peer deps...');
  execSync('npm ci --legacy-peer-deps --ignore-scripts', { stdio: 'inherit' });
  
  // Create a custom Angular build script that bypasses version checks
  console.log('🔧 Creating custom build script...');
  const customBuildScript = `
const { execSync } = require('child_process');
const fs = require('fs');

console.log('🔨 Building Angular app with custom script...');

// Override Node.js version check
process.env.NODE_OPTIONS = '--max-old-space-size=4096';

try {
  // Use npx to run Angular CLI with specific version
  console.log('📦 Running Angular build...');
  execSync('npx --yes @angular/cli@20.1.3 build --configuration=production', { 
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
  });
  
  console.log('✅ Angular build completed successfully');
} catch (error) {
  console.error('❌ Angular build failed:', error.message);
  process.exit(1);
}
`;

  const customBuildPath = path.join(angularAppPath, 'custom-build.js');
  fs.writeFileSync(customBuildPath, customBuildScript);
  
  // Run the custom build script
  console.log('🔨 Running custom Angular build...');
  execSync('node custom-build.js', { stdio: 'inherit' });
  
  // Run the post-build script if it exists
  const buildProdPath = path.join(angularAppPath, 'build-prod.js');
  if (fs.existsSync(buildProdPath)) {
    console.log('🔧 Running post-build script...');
    execSync('node build-prod.js', { stdio: 'inherit' });
  }
  
  // Verify build output
  const buildOutputPath = path.join(angularAppPath, 'dist/audienzo-app/browser');
  if (fs.existsSync(buildOutputPath)) {
    console.log('✅ Angular build completed successfully');
    console.log(`📁 Build output: ${buildOutputPath}`);
    
    // List build files
    const files = fs.readdirSync(buildOutputPath);
    console.log('📄 Build files:');
    files.forEach(file => {
      console.log(`   - ${file}`);
    });
    
    // Clean up custom build script
    if (fs.existsSync(customBuildPath)) {
      fs.unlinkSync(customBuildPath);
      console.log('🧹 Cleaned up custom build script');
    }
  } else {
    console.error('❌ Angular build output not found');
    process.exit(1);
  }
  
} catch (error) {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
}

console.log('🎉 Robust Angular build process completed successfully!'); 