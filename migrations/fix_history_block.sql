-- One-time cleanup migration to fix corrupted history_block entries
-- This removes history_block entries that contain escaped JSON strings instead of proper JSON objects

UPDATE audio_recordings
SET history_block = NULL
WHERE JSON_TYPE(history_block) = 'ARRAY'
  AND JSON_TYPE(JSON_EXTRACT(history_block, '$[0]')) = 'STRING';
