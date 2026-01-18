-- Migration: add transcription_error column to audio_recordings
ALTER TABLE audio_recordings ADD COLUMN IF NOT EXISTS transcription_error TEXT NULL;