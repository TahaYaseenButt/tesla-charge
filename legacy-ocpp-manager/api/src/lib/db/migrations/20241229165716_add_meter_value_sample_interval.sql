ALTER TABLE setting
ADD COLUMN meter_value_sample_interval INTEGER NOT NULL DEFAULT 60;
UPDATE setting
SET meter_value_sample_interval = 60;