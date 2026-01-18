-- Add medicines column to team_documents table
ALTER TABLE team_documents 
ADD COLUMN IF NOT EXISTS medicines VARCHAR(500) NULL COMMENT 'Medicine/Brand name for detailing practice';

-- Add index for faster filtering
CREATE INDEX IF NOT EXISTS idx_medicines ON team_documents(medicines);
