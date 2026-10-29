-- TASK-28: 결과 버전 확인·수정. 수정 요청은 명령 식별자(command_id)로 한 번만 처리한다.
-- 수정으로 대체된 결과 버전은 표식을 남겨 정상 완성본으로 다시 표시되지 않게 한다(행 삭제 없음).
CREATE TABLE result_version_marks (
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  result_version integer NOT NULL CHECK (result_version >= 1),
  superseded_at timestamptz NOT NULL,
  -- 대체되던 시점의 검수 상태. 이전 버전 조회·구분용이며 정상 완성본 판정에는 쓰지 않는다.
  review_at_supersede text NOT NULL CHECK (review_at_supersede IN ('NONE', 'PENDING', 'PASSED', 'REJECTED')),
  command_id text NOT NULL,
  PRIMARY KEY (interview_id, result_version)
);

CREATE TABLE result_revisions (
  id uuid PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  command_id text NOT NULL CHECK (length(btrim(command_id)) > 0),
  kind text NOT NULL CHECK (kind IN ('EXCLUDE', 'EDIT_TEXT', 'VOICE', 'RETRY')),
  request_hash text NOT NULL,
  plan_version integer,
  job_id uuid REFERENCES jobs (id),
  remake text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  UNIQUE (interview_id, command_id)
);

-- 사용자가 완성 결과를 확인한 기록. 시간이 지났다고 자동으로 만들어지지 않는다.
CREATE TABLE result_confirmations (
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  result_version integer NOT NULL CHECK (result_version >= 1),
  confirmed_at timestamptz NOT NULL,
  PRIMARY KEY (interview_id, result_version)
);
