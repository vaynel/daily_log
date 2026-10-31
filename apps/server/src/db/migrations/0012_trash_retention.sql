-- TASK-29: 휴지통(30일)·영구 삭제·서버 사본 한 달 정리·음성 수명. Drive 백업(backup_*)과 완성 영상(RESULT 버전)은 어떤 삭제도 전파받지 않는다(FK·삭제 없음).

-- 기록 단위 휴지통: deleted_at/purge_at 은 한 쌍이며 purge_at = deleted_at + 30일(재삭제로 연장하지 않음).
-- server_purged_at: 영구 삭제로 서버 사본(대화·첨부·요약)을 지운 시각. 행은 영상·백업 연결 메타데이터를 위해 남는다.
-- server_cleaned_at: 한 달 자동 정리(백업 검증 후)로 서버 사본을 지운 시각. cleanup_blocked_reason: 정리 대기 사유.
ALTER TABLE interviews
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN purge_at timestamptz,
  ADD COLUMN server_purged_at timestamptz,
  ADD COLUMN server_cleaned_at timestamptz,
  ADD COLUMN cleanup_blocked_reason text,
  ADD COLUMN cleanup_checked_at timestamptz,
  ADD CONSTRAINT interviews_trash_pair CHECK ((deleted_at IS NULL) = (purge_at IS NULL));

-- 영구 삭제된 기록의 생활일은 다시 쓸 수 있어야 하므로 유일성은 남아 있는 행에만 적용한다.
ALTER TABLE interviews DROP CONSTRAINT interviews_owner_id_life_date_key;
CREATE UNIQUE INDEX interviews_owner_life_date_live ON interviews (owner_id, life_date) WHERE server_purged_at IS NULL;

-- 항목·첨부 단위 휴지통(기록 일부 삭제). deleted_via_item: 항목을 지울 때 함께 지워진 첨부(항목 복구 때 함께 복구).
ALTER TABLE conversation_items ADD COLUMN deleted_at timestamptz;
ALTER TABLE attachment_refs ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_via_item boolean NOT NULL DEFAULT false;

-- 음성: 조기 삭제·만료 삭제는 DELETED 로 남기고 사유를 기록한다.
ALTER TABLE audio_segments DROP CONSTRAINT audio_segments_status_check;
ALTER TABLE audio_segments
  ADD CONSTRAINT audio_segments_status_check CHECK (status IN ('UNPROCESSED', 'INTERRUPTED', 'PROCESSED', 'EXPIRED', 'DELETED')),
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN delete_reason text CHECK (delete_reason IN ('EARLY_PROCESSED', 'MONTH_EXPIRED'));

-- 첨부 원본 파일 삭제 대기열. 같은 파일을 다른 참조가 가리키면 삭제하지 않고, 파일 삭제 실패는 다음 훑기에서 다시 시도한다.
CREATE TABLE purge_file_queue (
  storage_key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
