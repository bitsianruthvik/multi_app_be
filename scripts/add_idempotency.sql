-- Add idempotency column and unique index to audio_recordings
ALTER TABLE audio_recordings
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255) NULL;

-- Create unique index only if not exists (MySQL doesn't support IF NOT EXISTS for CREATE INDEX)
-- So check and create using dynamic SQL if desired. The following is a safe two-step:
ALTER TABLE audio_recordings
  ADD UNIQUE INDEX uq_audio_idempotency (idempotency_key);
