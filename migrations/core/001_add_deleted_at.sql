-- Migration: add soft-delete column to all core data tables.
-- Run once against an existing database. Safe to run on a fresh schema
-- only if the column does not already exist (IF NOT EXISTS guard not available
-- for ADD COLUMN in all MySQL versions; wrap in stored proc if needed for re-runs).

ALTER TABLE features
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;

ALTER TABLE features_capability
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;

ALTER TABLE role_capability
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;

ALTER TABLE companies
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;

ALTER TABLE apps
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;

ALTER TABLE teams
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;

ALTER TABLE roles
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;

ALTER TABLE users
  ADD COLUMN deleted_at DATETIME NULL DEFAULT NULL;
