-- TASK-29: 휴지통·복구·영구 삭제와 서버 보관 수명.
-- 서버 사본 정리는 Drive 백업(backup_items/backup_states)과 완성 영상(RESULT 버전·videos 파일)을 건드리지 않는다.

-- 기록 단위: 사용자 삭제(휴지통 30일) / 서버 사본 영구 삭제 / 한 달 자동 정리는 서로 다른 열이다.
ALTER TABLE interviews
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN purge_at timestamptz,
  ADD COLUMN server_purged_at timestamptz,
  ADD COLUMN server_cleaned_at timestamptz,
  ADD COLUMN cleanup_blocked_reason text,
  ADD COLUMN cleanup_checked_at timestamptz,
  ADD CONSTRAINT interviews_trash_pair CHECK ((deleted_at IS NULL) = (purge_at IS NULL)),
  ADD CONSTRAINT interviews_purged_needs_deleted CHECK (server_purged_at IS NULL OR deleted_at IS NOT NULL);
CREATE INDEX interviews_trash_idx ON interviews (purge_at) WHERE deleted_at IS NOT NULL AND server_purged_at IS NULL;

-- 기록 일부 삭제(대화 항목·첨부 한 건)도 같은 30일 휴지통을 쓴다.
ALTER TABLE conversation_items
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN purge_at timestamptz,
  ADD CONSTRAINT conversation_items_trash_pair CHECK ((deleted_at IS NULL) = (purge_at IS NULL));
ALTER TABLE attachment_refs
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN purge_at timestamptz,
  ADD CONSTRAINT attachment_refs_trash_pair CHECK ((deleted_at IS NULL) = (purge_at IS NULL));
CREATE INDEX conversation_items_trash_idx ON conversation_items (purge_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX attachment_refs_trash_idx ON attachment_refs (purge_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX attachment_refs_storage_key_idx ON attachment_refs (storage_key);

-- 임시 음성: 파일 위치(있을 때), 처리 중 참조, 파일 삭제 시각. 음성은 Drive 백업 대상이 아니다.
ALTER TABLE audio_segments
  ADD COLUMN file_key text,
  ADD COLUMN in_processing boolean NOT NULL DEFAULT false,
  ADD COLUMN file_deleted_at timestamptz,
  ADD COLUMN deleted_reason text CHECK (deleted_reason IN ('PROCESSED', 'EXPIRED', 'RECORD_PURGED'));

-- 파일 삭제 재시도 큐. DB 행을 먼저 정리하고 파일은 나중에 지우므로, 중간에 죽거나 지우기에 실패해도 다음 훑기에서 이어서 지운다.
CREATE TABLE purge_file_queue (
  kind text NOT NULL CHECK (kind IN ('ATTACHMENT', 'AUDIO')),
  storage_key text NOT NULL,
  queued_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  PRIMARY KEY (kind, storage_key)
);
