-- Preset gallery limits held inside the submit batch (CONTRACT §2.7): a refusal like quota's,
-- and each contributor's presets submitted today, which deletes don't give back.
ALTER TABLE refusals ADD COLUMN preset_limit INTEGER CONSTRAINT preset_limit CHECK (preset_limit IS NULL);
ALTER TABLE contributors ADD COLUMN preset_day TEXT;
ALTER TABLE contributors ADD COLUMN preset_day_n INTEGER NOT NULL DEFAULT 0;
