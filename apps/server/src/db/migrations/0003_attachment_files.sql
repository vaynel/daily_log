-- TASK-12: (기존 TASK-11 내부 API 호환을 위해 kind 기본값 PHOTO 유지) 사진·Markdown·학습 메모 첨부. 원본은 내용 해시(checksum) 이름으로 한 번만 저장하고,
-- 기록별 참조(attachment_refs)가 같은 파일을 가리킨다. 촬영 시각은 EXIF 에 있을 때만 채우며 업로드 시각(saved_at)과 섞지 않는다.
ALTER TABLE attachment_refs
  ADD COLUMN kind text NOT NULL DEFAULT 'PHOTO' CHECK (kind IN ('PHOTO', 'MARKDOWN', 'NOTE')),
  ADD COLUMN original_name text,
  ADD COLUMN mime_type text,
  ADD COLUMN size_bytes bigint,
  ADD COLUMN captured_at timestamptz,
  ADD COLUMN captured_source text CHECK (captured_source IN ('EXIF', 'EXIF_ASSUMED_KST')),
  ADD CONSTRAINT attachment_captured_pair CHECK ((captured_at IS NULL) = (captured_source IS NULL));
CREATE INDEX attachment_refs_checksum_idx ON attachment_refs (interview_id, checksum);
