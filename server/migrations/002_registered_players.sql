-- Keeps already-initialized development databases compatible with conservative
-- scorer settlement, which requires a positively matched squad identity.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS registered_player_ids text[] NOT NULL DEFAULT '{}';
