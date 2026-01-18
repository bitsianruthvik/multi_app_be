-- Add medicine column to audio_recordings table to track which medicine each recording is about
ALTER TABLE audio_recordings ADD COLUMN IF NOT EXISTS medicine VARCHAR(255) NULL COMMENT 'Medicine/Brand name for the recording';

-- Add index on medicine for faster lookups
CREATE INDEX IF NOT EXISTS idx_audio_medicine ON audio_recordings(medicine);
