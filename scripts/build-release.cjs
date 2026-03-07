#!/usr/bin/env node
// =============================================================================
// JP343 Extension - Release Build Script
// Erstellt ZIP-Dateien fuer Chrome und Firefox
// =============================================================================

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT_DIR = path.join(__dirname, '..');
const RELEASE_DIR = path.join(ROOT_DIR, 'releases');

// Version aus package.json lesen
const packageJson = require(path.join(ROOT_DIR, 'package.json'));
const version = packageJson.version;

// Browser-Konfigurationen
const browsers = [
  {
    name: 'Chrome',
    buildCmd: 'npm run build',
    distDir: path.join(ROOT_DIR, 'dist', 'chrome-mv3'),
    zipName: `jp343-extension-v${version}-chrome.zip`
  },
  {
    name: 'Firefox',
    buildCmd: 'npm run build:firefox',
    distDir: path.join(ROOT_DIR, 'dist', 'firefox-mv2'),
    zipName: `jp343-extension-v${version}-firefox.zip`
  }
];

// ZIP-Datei erstellen
async function createZip(distDir, zipPath, zipName) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      const sizeKB = (archive.pointer() / 1024).toFixed(1);
      console.log(`   ✅ ${zipName} (${sizeKB} KB)`);
      resolve();
    });

    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(distDir, false);
    archive.finalize();
  });
}

async function buildRelease() {
  console.log(`\n🚀 Building JP343 Extension v${version}\n`);
  console.log('=' .repeat(50));

  // Release-Ordner erstellen/leeren
  if (!fs.existsSync(RELEASE_DIR)) {
    fs.mkdirSync(RELEASE_DIR, { recursive: true });
  }

  const createdFiles = [];

  // Beide Browser bauen
  for (const browser of browsers) {
    console.log(`\n📦 Building for ${browser.name}...`);

    try {
      execSync(browser.buildCmd, { cwd: ROOT_DIR, stdio: 'inherit' });

      const zipPath = path.join(RELEASE_DIR, browser.zipName);
      console.log(`\n📁 Creating ZIP...`);
      await createZip(browser.distDir, zipPath, browser.zipName);
      createdFiles.push(browser.zipName);
    } catch (error) {
      console.error(`   ❌ ${browser.name} build failed:`, error.message);
    }
  }

  // Zusammenfassung
  console.log('\n' + '=' .repeat(50));
  console.log(`\n✨ Release v${version} ready!\n`);
  console.log('Created files:');
  createdFiles.forEach(f => console.log(`   releases/${f}`));

  console.log('\n📋 Next steps:');
  console.log('1. Test both ZIPs locally');
  console.log('2. git add . && git commit -m "Release v' + version + '"');
  console.log('3. git push');
  console.log('4. Create GitHub Release and upload both ZIPs');
  console.log('   https://github.com/mh-343/jp343-extension/releases/new\n');
}

buildRelease().catch(console.error);
