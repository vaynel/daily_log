-- TASK-28: 결과 수정 요청과 결과 버전 상태. 이전 결과는 지우지 않고 '대체됨' 표식만 남긴다.
CREATE TABLE result_version_marks (
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  -- 대체되던 시점에 제작 완료 + 검수 통과였던 버전만 true. 미통과 버전은 어떤 경우에도 정상본이 되지 않는다.
  was_passed boolean NOT NULL,
  superseded_at timestamptz NOT NULL,
  superseded_by_revision integer NOT NULL,
  PRIMARY KEY (interview_id, version)
);

CREATE TABLE result_revisions (
  id uuid PRIMARY KEY,
  interview_id uuid NOT NULL REFERENCES interviews (id) ON DELETE CASCADE,
  command_id text NOT NULL CHECK (length(btrim(command_id)) > 0),
  kind text NOT NULL CHECK (kind IN ('EXCLUDE', 'EDIT_TEXT', 'VOICE', 'RETRY')),
  revision integer NOT NULL,
  plan_version integer,
  job_id uuid REFERENCES jobs (id),
  -- 다시 만들 범위. 장면·내레이션·자막은 항상 함께 지정한다. 발언 원문은 저장하지 않는다.
  remake_scope text[] NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (interview_id, command_id)
);
