-- TASK-22: 사용자가 확인한 반복 제외 기준. 발언 원문은 저장하지 않고 범주와 짧은 키워드만 둔다.
-- history 는 동작·범주·키워드 개수만 담는다. 비공개 원본(interviews 등)과는 연결하지 않으므로 규칙을 지워도 원본은 그대로다.
CREATE TABLE exclusion_rules (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  category text NOT NULL CHECK (category IN ('PRIVATE_LIFE', 'WORK_CONFIDENTIAL', 'OTHER')),
  keywords text[] NOT NULL CHECK (cardinality(keywords) BETWEEN 1 AND 5),
  active boolean NOT NULL DEFAULT true,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exclusion_rules_owner_idx ON exclusion_rules (owner_id, created_at);
