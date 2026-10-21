# TASK-12 사진·Markdown·학습 메모 첨부

## 입력 동선 (웹 `AttachPanel`)
사진첩(여러 장), 카메라(`capture=environment`), Markdown 파일, 학습 메모(텍스트). 첨부 버튼은 키보드로 초점을 받고, 상태는 `aria-live` 영역에 표시된다.
항목은 서버가 201/200으로 저장을 확인한 뒤에만 "첨부됨"이 된다. 실패·중단은 사유와 "다시 시도"(재시도 가능한 경우)를 보여준다. 재시도는 같은 멱등 키를 쓴다.

## 제한 (서버 `attachments/policy.ts`가 최종 검사, 웹은 빠른 안내용)
| 종류 | 형식 | 크기 |
|---|---|---|
| PHOTO | JPEG·PNG·GIF·WebP (시그니처로 판별, 이름·Content-Type은 신뢰하지 않음) | 10MB |
| MARKDOWN | `.md`/`.markdown`, UTF-8, NUL 없음, 비어 있지 않음 | 1MB |
| NOTE(학습 메모) | UTF-8 텍스트 | 100KB |
| 기록당 | 중복 제외 30개 | |

손상 검사: JPEG(SOI·세그먼트 구조·SOF·EOI), PNG(모든 청크 CRC·IHDR·IDAT·IEND), GIF(트레일러), WebP(RIFF 크기 일치). 검사 실패 시 파일도 DB 참조도 만들지 않는다. HEIC는 미지원(Android 카메라 기본 JPEG).
오류 코드: 415 UNSUPPORTED_TYPE, 413 TOO_LARGE, 422 UNREADABLE_FILE/EMPTY_FILE, 409 TOO_MANY_ATTACHMENTS/CONFIRMED_LOCKED/IDEMPOTENCY_CONFLICT, 404 NOT_FOUND.

## 저장·중복
원본은 `$FILE_STORAGE_DIR/attachments/<sha256>.<ext>`에 내용당 한 번만(임시 파일 후 rename). 같은 기록에 같은 내용을 다시 붙이면 기존 참조를 돌려주고(`duplicate:true`) 새 참조도 만들지 않는다. 다른 기록은 참조만 추가하고 파일은 공유한다. DB 저장이 거부되면 이번 요청이 새로 만든 파일은 지운다. 확정된 기록은 TASK-62 규칙대로 거부.

## 촬영 시각
JPEG EXIF `DateTimeOriginal`(없으면 `DateTimeDigitized`)만 사용. `OffsetTime`이 있으면 `EXIF`, 없으면 한국 시간으로 가정하고 `EXIF_ASSUMED_KST`로 구분 표시. 없음·형식 오류·존재하지 않는 날짜·24시간 이상 미래는 `captured_at=NULL`이며 업로드 시각(`saved_at`)·파일 수정 시각으로 대체하지 않는다. PNG/GIF/WebP는 촬영 시각을 읽지 않는다.

## API (로그인 필요, 소유자는 세션 sub)
- `POST /api/records` `{lifeDate?}` → 기록 시작/이어보기 (TASK-11 규칙)
- `POST /api/records/:id/attachments` 본문=원본 바이트, 헤더 `x-idempotency-key`, `x-attachment-kind`(PHOTO|MARKDOWN|NOTE), `x-file-name`(URI 인코딩), 선택 `x-item-id`
- `GET /api/records/:id/attachments` 종류·이름·업로드 시각·촬영 시각 목록
- 원본 열람: 기존 `GET /api/attachments/<storageKey>`

## 검증 절차
```
DATABASE_URL=... npm run db:migrate && npm test
npm i --no-save playwright-core
DATABASE_URL=... PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=... node scripts/attachments-e2e.mjs   # PC + Android 에뮬레이션(실기기 아님)
```
