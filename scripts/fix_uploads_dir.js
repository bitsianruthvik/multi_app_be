import fs from 'fs';
import path from 'path';

const root = process.cwd();
const tmpDir = path.join(root, 'tmp');
const publicUploads = path.join(root, 'public', 'uploads');

function ensureUploadsDir() {
  if (fs.existsSync(publicUploads)) {
    const stat = fs.statSync(publicUploads);
    if (!stat.isDirectory()) {
      console.log('Removing file at public/uploads and creating directory');
      fs.unlinkSync(publicUploads);
      fs.mkdirSync(publicUploads, { recursive: true });
    }
  } else {
    fs.mkdirSync(publicUploads, { recursive: true });
  }
}

function moveIfExists(src, dest) {
  if (fs.existsSync(src)) {
    if (!fs.existsSync(dest)) {
      fs.renameSync(src, dest);
      console.log('Moved', src, '->', dest);
    } else {
      console.log('Destination exists, skipping', dest);
    }
  }
}

function processTmpRoot() {
  const items = fs.readdirSync(tmpDir);
  for (const it of items) {
    const full = path.join(tmpDir, it);
    const stat = fs.statSync(full);
    if (stat.isFile()) {
      // move mp3/webm files that look like original_/processed_/upload_
      if (/^(original|processed|upload)_\d+\./.test(it)) {
        const dest = path.join(publicUploads, it);
        moveIfExists(full, dest);
      }
    } else if (stat.isDirectory()) {
      // look inside per-request dirs for original/processed mp3s
      const files = fs.readdirSync(full);
      for (const f of files) {
        if (/^(original|processed)_\d+\.mp3$/.test(f)) {
          const src = path.join(full, f);
          const dest = path.join(publicUploads, f);
          moveIfExists(src, dest);
        }
      }
    }
  }
}

function main() {
  try {
    ensureUploadsDir();
    processTmpRoot();
    console.log('Fix uploads dir completed');
  } catch (e) {
    console.error('Failed to fix uploads dir:', e);
    process.exit(1);
  }
}

main();
