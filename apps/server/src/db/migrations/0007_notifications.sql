-- TASK-18: 하루 1회 인터뷰 알림과 결과 알림. 알림 전달 상태는 기록·제작 상태(interviews/pipeline_states)와 별도 테이블에만 저장한다.
CREATE TABLE notification_settings (
  owner_id text PRIMARY KEY,
  -- Asia/Seoul 기준 'HH:MM'. 기본 22:00.
  interview_time text NOT NULL DEFAULT '22:00' CHECK (interview_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- 브라우저가 보고한 알림 권한(서버가 직접 알 수 없다).
  permission text NOT NULL DEFAULT 'unknown' CHECK (permission IN ('unknown', 'default', 'granted', 'denied', 'unsupported')),
  permission_reported_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_owner_idx ON push_subscriptions (owner_id) WHERE active;

-- dedupe_key 는 (알림 종류, 소유자, 생활일 또는 기록·버전)으로 만든다. 같은 키는 한 번만 만들어진다(재시작·중복 호출 포함).
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('INTERVIEW_REMINDER', 'RESULT_COMPLETED', 'RESULT_REVISED', 'PROCESSING_FAILED', 'BACKUP_FAILED')),
  dedupe_key text NOT NULL UNIQUE,
  life_date date,
  interview_id uuid,
  -- 앱 안에서 이동할 경로. 기록 알림은 해당 기록 상세로 연결한다.
  url text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  -- ACCEPTED 는 푸시 서비스가 받았다는 뜻이며 기기 표시를 보장하지 않는다.
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'UNDELIVERABLE', 'FAILED', 'SKIPPED')),
  attempts smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX notifications_pending_idx ON notifications (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX notifications_owner_idx ON notifications (owner_id, created_at DESC);
