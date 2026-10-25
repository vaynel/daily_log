-- 제품 음성 인터뷰(TASK-17): 생활일 기록 1건당 실시간 대화 사용량. 하루 1회·10분·700원 상한의 서버측 근거.
-- 기록(interviews)이 (owner, 생활일) 당 1건이므로 이 행도 하루 1건이다. 이어하기(일시정지 후 재개)는 같은 행에 합산한다.
CREATE TABLE interview_live_usage (
  interview_id uuid PRIMARY KEY REFERENCES interviews (id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  used_ms bigint NOT NULL DEFAULT 0 CHECK (used_ms >= 0),
  cost_krw numeric(12, 2) NOT NULL DEFAULT 0 CHECK (cost_krw >= 0),
  connections integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ENDED')),
  end_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
