ALTER TABLE matches ADD COLUMN IF NOT EXISTS result_override boolean NOT NULL DEFAULT false;
