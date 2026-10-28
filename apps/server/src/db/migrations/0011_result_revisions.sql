-- TASK-28: 결과 수정(제외·글 수정·재시도)은 새 제작 요청으로만 처리하고, 이전 결과 버전은 지우지 않고 "이전 버전"으로 표식한다.
-- 표식된 버전은 다시 현재 결과가 되지 않으며, 표식 시점의 표시 상태(prior_status)를 보존한다.
CREATE TABLE result_version_marks (
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  prior_status text NOT NULL,
  superseded_at timestamptz NOT NULL,
  revision_id uuid NOT NULL,
  PRIMARY KEY (interview_id, version)
);

-- 수정 요청 기록. command_id 는 사용자 명령 식별자로, 같은 명령의 재전송은 한 번만 처리한다.
CREATE TABLE result_revisions (
  id uuid PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  command_id text NOT NULL CHECK (length(btrim(command_id)) > 0),
  scope text NOT NULL CHECK (scope IN ('EXCLUDE', 'EDIT_TEXT')),
  item_id text NOT NULL,
  summary_version integer NOT NULL,
  plan_version integer NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs (id),
  created_at timestamptz NOT NULL,
  UNIQUE (interview_id, command_id)
);

-- 사용자가 결과 영상을 직접 보고 확인한 기록. 기한이 지나도 이 행이 없으면 확인되지 않은 결과다(자동 확인·자동 공개 없음).
CREATE TABLE result_confirmations (
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  confirmed_at timestamptz NOT NULL,
  command_id text NOT NULL CHECK (length(btrim(command_id)) > 0),
  PRIMARY KEY (interview_id, version)
);
