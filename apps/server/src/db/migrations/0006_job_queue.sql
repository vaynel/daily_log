-- TASK-15: 작업 큐와 중단·오류 복구. 완료 단계·자동 재시도 횟수·외부 요청 식별자를 영속화한다.
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  subject_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  stages text[] NOT NULL CHECK (cardinality(stages) >= 1),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED')),
  wait_reason text CHECK (wait_reason IN ('BUDGET', 'PERMISSION', 'EXTERNAL_RESULT_UNKNOWN')),
  -- 작업 전체(모든 단계 합산)에서 자동 재시도는 최대 1회. 수동 재시도도 이 값을 계승하며 초기화하지 않는다.
  auto_retries_used smallint NOT NULL DEFAULT 0 CHECK (auto_retries_used BETWEEN 0 AND 1),
  manual_requests integer NOT NULL DEFAULT 0 CHECK (manual_requests >= 0),
  error_code text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'WAITING') = (wait_reason IS NOT NULL))
);
CREATE INDEX jobs_state_idx ON jobs (state, created_at);

-- 단계별 진행. DONE 단계의 결과는 재시도·재시작 후에도 보존된다.
CREATE TABLE job_stages (
  job_id uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  stage text NOT NULL,
  state text NOT NULL CHECK (state IN ('RUNNING', 'SENT', 'UNKNOWN', 'DONE', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  -- 유료 호출 직전에 먼저 저장하는 외부 요청 식별자(원장 멱등키와 동일).
  external_request_id text UNIQUE,
  budget_entry_id uuid,
  result jsonb,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, stage)
);

-- 사용자 수동 요청: 실제 사용자 명령 식별자와 연결. 같은 명령의 재전송은 한 번만 처리한다.
CREATE TABLE job_requests (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  command_id text NOT NULL UNIQUE CHECK (length(btrim(command_id)) > 0),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  kind text NOT NULL CHECK (kind IN ('MANUAL_RETRY', 'EXTERNAL_RESOLVE')),
  prior_state text NOT NULL,
  prior_wait_reason text,
  inherited_auto_retries smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  event text NOT NULL,
  stage text,
  code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
