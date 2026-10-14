

ALTER TABLE submissions ADD COLUMN work_attribution TEXT CHECK(work_attribution IS NULL OR json_valid(work_attribution));
ALTER TABLE landing_receipts ADD COLUMN work_attribution TEXT CHECK(work_attribution IS NULL OR json_valid(work_attribution));
