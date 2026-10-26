-- TASK-27: Google Drive 일일 백업. Drive 연결(로그인과 분리), 백업 항목(버전·무결성), 기록별 백업 상태.
-- 서버 원본의 삭제·만료·휴지통은 이 테이블이나 Drive 파일을 지우지 않는다(FK 없음, 삭제 전파 없음).

-- 갱신 토큰은 AES-256-GCM 으로 암호화한 값만 저장한다. 연결 해제 시 이 행(토큰)만 지우고 백업 항목은 남긴다.
CREATE TABLE drive_connections (
  owner_id text PRIMARY KEY,
  email text NOT NULL,
  scope text NOT NULL,
  refresh_token_enc text NOT NULL,
  status text NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED', 'AUTH_EXPIRED')),
  root_folder_id text,
  last_error_code text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 백업 대상 한 건(기록 스냅샷·첨부·완성 영상)의 한 버전. 같은 내용 해시는 한 번만 올린다.
-- 음성(audio_segments)은 어떤 종류로도 들어갈 수 없다(item_kind 제약).
CREATE TABLE backup_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  interview_id uuid NOT NULL,
  life_date date NOT NULL,
  item_kind text NOT NULL CHECK (item_kind IN ('RECORD', 'ATTACHMENT', 'VIDEO')),
  item_key text NOT NULL,
  -- 사람이 읽는 대응 버전: 기록은 revision·요약/계획/결과 버전, 첨부는 내용 해시, 영상은 RESULT 버전.
  version_label text NOT NULL,
  content_sha256 text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  drive_file_id text,
  drive_name text,
  drive_md5 text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'FAILED')),
  verified_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, interview_id, item_kind, item_key, content_sha256),
  CHECK ((status = 'VERIFIED') = (verified_at IS NOT NULL AND drive_file_id IS NOT NULL))
);
CREATE INDEX backup_items_interview_idx ON backup_items (interview_id);

-- 기록별 백업 상태와 사유(민감정보 없는 코드만). pipeline_states.backup 은 이 값에서 파생한다.
CREATE TABLE backup_states (
  interview_id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING', 'VERIFIED', 'FAILED')),
  reason text,
  job_id uuid,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
