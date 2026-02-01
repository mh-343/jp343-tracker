#!/usr/bin/env node
// =============================================================================
// JP343 Extension - Release Build Script
// Erstellt eine ZIP-Datei fuer die Veroeffentlichung
// =============================================================================

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist', 'chrome-mv3');
const RELEASE_DIR = path.join(ROOT_DIR, 'releases');

// Version aus package.json lesen
const packageJson = require(path.join(ROOT_DIR, 'package.json'));
const version = packageJson.version;

async function buildRelease() {
  console.log(`\n🚀 Building JP343 Extension v${version}\n`);

  // 1. Production Build
  console.log('📦 Running production build...');
  execSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit' });

  // 2. Release-Ordner erstellen
  if (!fs.existsSync(RELEASE_DIR)) {
    fs.mkdirSync(RELEASE_DIR, { recursive: true });
  }

  // 3. ZIP erstellen
  const zipName = `jp343-extension-v${version}.zip`;
  const zipPath = path.join(RELEASE_DIR, zipName);

  console.log(`\n📁 Creating ${zipName}...`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      const sizeKB = (archive.pointer() / 1024).toFixed(1);
      console.log(`✅ Created ${zipName} (${sizeKB} KB)`);
      resolve();
    });

    archive.on('error', reject);
    archive.pipe(output);

    // Alle Dateien aus dist/chrome-mv3 hinzufuegen
    archive.directory(DIST_DIR, false);
    archive.finalize();
  });

  console.log(`\n✨ Release ready: releases/${zipName}`);
  console.log('\nNext steps:');
  console.log('1. git add . && git commit -m "Release v' + version + '"');
  console.log('2. git push');
  console.log('3. gh release create v' + version + ' ./releases/' + zipName + ' --title "v' + version + '"');
  console.log('   (oder manuell auf GitHub Releases hochladen)\n');
}

buildRelease().catch(console.error);
