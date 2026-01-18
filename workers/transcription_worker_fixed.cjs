#!/usr/bin/env node
// workers/transcription_worker_fixed.cjs
// Minimal stub worker (backup). Does not reference removed columns.
try {
  require("dotenv").config();
} catch (e) {}
console.log("[worker][fixed-backup] stub worker loaded.");
process.exit(0);
