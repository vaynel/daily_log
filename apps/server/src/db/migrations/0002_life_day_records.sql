-- 생활일별 기록 스키마 (TASK-11). 실제 시각(timestamptz, UTC)과 생활일(date)을 분리 저장한다.
CREATE TABLE interviews (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  life_date date NOT NULL,
  started_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'CONFIRMED')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, life_date)
);

-- 재개 시각은 생활일과 별도로 기록한다.
CREATE TABLE interview_resumes (
  id bigserial PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  resumed_at timestamptz NOT NULL
);

CREATE TABLE conversation_items (
  id uuid PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  idempotency_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('QUESTION', 'ANSWER')),
  body text NOT NULL,
  saved_at timestamptz NOT NULL,
  UNIQUE (interview_id, seq),
  UNIQUE (interview_id, idempotency_key)
);

CREATE TABLE attachment_refs (
  id uuid PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  item_id uuid REFERENCES conversation_items (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  storage_key text NOT NULL,
  checksum text NOT NULL,
  saved_at timestamptz NOT NULL,
  UNIQUE (interview_id, idempotency_key)
);

-- 요약·제작 계획·결과는 덮어쓰지 않고 버전으로 누적한다.
CREATE TABLE record_versions (
  id uuid PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('SUMMARY', 'PRODUCTION_PLAN', 'RESULT')),
  version integer NOT NULL CHECK (version >= 1),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (interview_id, kind, version)
);

-- 제작·검수·백업 상태는 서로 독립된 열로 관리한다.
CREATE TABLE pipeline_states (
  interview_id uuid PRIMARY KEY REFERENCES interviews (id) ON DELETE CASCADE,
  production text NOT NULL DEFAULT 'NONE' CHECK (production IN ('NONE', 'QUEUED', 'RUNNING', 'DONE', 'FAILED')),
  review text NOT NULL DEFAULT 'NONE' CHECK (review IN ('NONE', 'PENDING', 'PASSED', 'REJECTED')),
  backup text NOT NULL DEFAULT 'NONE' CHECK (backup IN ('NONE', 'PENDING', 'VERIFIED', 'FAILED')),
  updated_at timestamptz NOT NULL
);

-- 임시 음성: 최초 저장 시각·만료 시각은 불변. 재접속·재전송으로 연장되지 않는다.
CREATE TABLE audio_segments (
  id uuid PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  first_saved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('UNPROCESSED', 'INTERRUPTED', 'PROCESSED', 'EXPIRED')),
  status_changed_at timestamptz NOT NULL,
  UNIQUE (interview_id, idempotency_key),
  CHECK (expires_at > first_saved_at)
);
