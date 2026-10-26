-- TASK-26: quality regeneration is independent of processing retries, never reset on restart.
ALTER TABLE jobs ADD COLUMN quality_regenerations_used smallint NOT NULL DEFAULT 0 CHECK (quality_regenerations_used BETWEEN 0 AND 1);
ALTER TABLE jobs ADD COLUMN quality_reasons text[] NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN quality_repair_stages text[] NOT NULL DEFAULT '{}';
CREATE TABLE job_quality_reviews (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  generation smallint NOT NULL CHECK (generation BETWEEN 0 AND 1),
  report jsonb NOT NULL,
  prior_results jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pipeline_states ADD COLUMN quality_reasons text[] NOT NULL DEFAULT '{}';
