-- Migration: add soft-delete column to audio_intelligence app tables.
-- Run once against an existing database.

ALTER TABLE audio_recordings
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;

ALTER TABLE company_documents
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;

ALTER TABLE team_documents
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;
