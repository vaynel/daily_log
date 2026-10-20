-- 개발 기반 초기 스키마. 실제 기록 스키마는 후속 Task(CORE/LOG)에서 확장한다.
CREATE TABLE sample_entries (
  id uuid PRIMARY KEY,
  entry_date date NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
