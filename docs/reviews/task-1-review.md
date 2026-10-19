# TASK-43 — TASK-1 독립 검수

검수일: 2026-10-19 UTC. 검수자: QA · 독립 검수(Codex). 개발 제출자: 개발 A · 기반·운영.

## 판정과 고정 입력

**PASS — TASK-1의 조사·설계 산출물 범위.** 아래 AC 4개를 제출자의 PASS 표기와 별개로 실제 Git 객체와 문서 전체에 대조했다. 이 범위에서 P0~P2 결함을 발견하지 않았다. 제품 구현, 기기 지원, 운영 성능 또는 출시 승인이 아니다. 최종 승인은 PM/관리자에게 요청한다.

- 검수 실행: `0a995f34-fd95-4946-a6c6-774cd94ba0f1`, packet `930250afae8f47fb7aa57b64cdf5dbdb06bc4a3256ff3d142e54c1732a98e6a9`.
- 선행 실행: `bf7927b1-2f6c-4731-ab26-d11c6313848b`, packet `b226e66ad57cd0a69ed6a6b5ce9f5673eee157f3c1a26537988d215c11947046`, sourceVersion 213.
- 제출 commit: `111e644ab54fc5e80c193562fc1095fe12807ab5`; tree: `5427836a314ab0cd29e317eb9d09889948ac100f`.
- 기준 commit: `686e92da29b72154182682dced58d8913193975b`; tree: `4b825dc642cb6eb9a060e54bf8d69288fbee4904`.
- 실제 origin: `https://github.com/vaynel/daily_log.git`. `/workspace` 격리 checkout에서 검사했다.
- `get_task`의 dependencies.latestRun과 읽기 전용 `/run/mandu/MANDU-HANDOFF.json`을 대조했다. 실제 HEAD와 tree가 inputArtifact의 commit/tree와 모두 일치한다. 호스트 bundle 경로는 접근하지 않았으므로 bundle 바이트 SHA256 자체를 재검산했다고 주장하지 않는다.
- 공통 계획 Q43-01(독립 대조), Q43-02(검수표·검사·커밋)를 등록했다. 최초 계획 요청은 workspace version을 넣어 거절되었으며, get_task/get_task_plan 재조회 후 plan version 0으로 등록 성공했다. 실패한 요청을 완료로 세지 않았다.

## TASK-1 완료 조건 대조표

아래 줄 번호는 위 제출 commit의 [조사 문서](../architecture/initial-assessment.md) 및 [검증 기록](../architecture/validation.md)을 가리킨다.

| 원래 완료 조건 | 독립 판정 | 실제 근거와 범위 |
| --- | --- | --- |
| AC-1. 조사 결과에 실제 origin·기준 커밋·기존 코드 재사용 범위가 기록된다. (검증: 읽기 전용 조사 기록) | PASS | 조사 7~17행, 검증 9~21행. 실제 remote 동일. git log에서 제출의 부모가 기준 commit이며 기준은 root commit임을 확인. 기준 ls-tree 출력 없음, 빈 tree 해시 일치. 제품 재사용 코드 0이라는 설명과 일치. |
| AC-2. 선정안에 Android·PC 지원과 순차 음성 처리·단일 렌더러 구성이 명시된다. (검증: 설계 검토) | PASS | 조사 34~46행: PWA 선정, Android Chrome·PC Chrome/Edge 전경 목표, Capacitor/Flutter 대안, 사진·메모 및 순차 녹음→STT→응답→TTS. 97행: renderer 프로세스 1개·동시 작업 1개·종료 미확인 대기. 구현/기기 성공으로 오인할 표현 없음. |
| AC-3. 기술 선택 근거와 검증 전 가정이 구분된다. (검증: 결정 기록) | PASS | 조사 34행은 React/Fastify를 설계 판단으로 명시. 48~73행은 공식 근거 6개와 기기·공급자·가격·서버·Wiki 미확정을 구분. QA도 아래 공식 자료를 열어 관련 근거를 확인. 기술 성능 실험으로 과장하지 않음. |
| AC-4. 후보가 서버 제약을 충족하지 못하면 미지원 근거와 대안을 표시한다. (검증: 제약 대조표) | PASS | 조사 135~153행: N100/16GB 공유·GPU 없음, 복수 renderer 및 GPU 생성 제외, 대기열·경량화 대안, 2 CPU/4GB 초기 제한. 포트 18081은 미확정 후보. 155~184행은 향후 실측·격리·롤백 절차이며 실행 결과로 주장하지 않음. |

## 제품 제약과 경계 검토

| 경계 | 근거 및 검수 결과 |
| --- | --- |
| 당일 기록·브리핑·첨부 | 조사 42~46, 106~111행: 사진/메모, 약 10분 순차 대화, 불확실한 사실 제외, 정확한 revision 1회 확인 후 제작. 문서 범위 이상 없음. 대화 자연스러움은 실기기 시험 필요. |
| 콘텐츠·비공개·삭제 | 46, 93~98, 114~115, 129행: 9:16/180초·동일 캐릭터/의상/목소리·음악 없음·AI 영상 서비스 금지, 원본 비공개·영상 제외/삭제 분리·삭제 tombstone. 정책 설계 존재를 확인했으며 실제 보안/삭제 보장은 미검증. |
| 월 50,000원·Pro 미지원 | 68~69, 118, 127~128행: 테스트/재시도 포함 예약·정산, 공급자 권한/가격 미확정 시 대기, 자동 유료 전환 없음. 단가와 월 실비 확인을 수행했다고 하지 않음. |
| 재시도·재제작·응답 유실 | 124~131행: 처리 재시도 1회와 품질 재제작 1회 별도 지속 카운터, 결과 유실 시 조회/조정 대기. 단위·통합 구현 검증과 구분됨. |
| N100 공유 서버 | 135~153행: 16GB만으로 공존 가능 판단 금지, 초기 가설 합계 6.5GiB가 기존 서비스·OS를 제외함을 명시. Mandu/n8n과 DB/Redis/볼륨/포트 분리, 자원 부족 시 대기. 호스트 실측 허위 주장을 발견하지 않음. |
| 환경·자료 제한 | 28, 65, 197행 및 검증 23/40/50행: Wiki/Flowchart 원문·제품 시험·호스트·기기 미검증을 반복 명시. 이 검수의 scoped MCP 도구 목록에도 Wiki/Flowchart 조회 도구 없음. 입력 파일에도 원문 없음. 패킷의 확정 요구만 대조했으며 원문 일치 검수는 NOT_RUN. |

필수 수정 요구: 없음(명시된 조사 범위). 후속 구현 전 PM/QA의 Wiki 00~09·Flowchart 원문 대조를 유지한다. 실기기, 공급자 권한/가격, 서버 공존 및 렌더 실측 게이트는 이 PASS로 해제되지 않는다. 개선 제안: 후속 구현 Task에서 열린 쟁점별 담당·완료 증거 링크를 연결하면 추적하기 쉽다.

## 실제 실행 증거

다음은 이번 QA 실행에서 직접 수행했다. shell 묶음 및 Python 검사는 각각 exit 0이었다.

| 명령/검사 | 관찰 결과 |
| --- | --- |
| `git remote get-url origin` | 위 origin과 일치 |
| `git log --format='%H %P %s' -2` | 제출→기준 부모 관계 확인; 기준 제목 `chore: initialize daily log runner baseline` |
| `git rev-parse HEAD HEAD^{tree}` | 불변 handoff의 제출 commit/tree와 일치 |
| `git rev-parse 686e92da29b72154182682dced58d8913193975b^{tree}` 및 `git ls-tree -r 686e92da29b72154182682dced58d8913193975b` | 빈 tree 해시 및 빈 파일 목록 |
| `git diff --check 686e92da29b72154182682dced58d8913193975b 111e644ab54fc5e80c193562fc1095fe12807ab5` | 출력 없음, 공백 오류 없음 |
| `git show --stat --oneline HEAD` (검수 전) | 문서 2개, 197+52=249줄 추가; 제품 코드 없음 |
| `git status --porcelain=v1`, `git branch --show-current` (검수 전) | 모두 출력 없음: clean detached HEAD |
| Python pathlib 존재 검사 | `/AGENTS.md`, `/workspace/AGENTS.md` 없음 |
| Python json + subprocess 대조 | handoff inputArtifact.commit/tree와 실제 Git 값 assert 통과 |
| Python UTF-8·코드 fence 쌍·상대 링크 검사 | 두 문서 모두 통과, 197/52줄 확인 |
| `nl -ba`로 문서 2개 전체 읽기 | 위 AC/제약 표와 직접 대조 |

후속 검수 기록은 `task-43-independent-review` 브랜치에 별도 커밋한다. 개발 문서 두 개는 수정하지 않는다. 최종 검수 commit은 Mandu 불변 보고서에 기록한다.

## 공식 근거 재확인

2026-10-19 UTC 웹 조회로 다음 문서의 관련 부분을 확인했다. 현재 공개 설명이 설계 근거를 지지하는지 확인한 것이며, 선행 담당자의 과거 웹 조회 자체를 재현한 것은 아니다.

- [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia): 보안 컨텍스트·사용자 권한, 권한/기기 실패 및 사용자 무응답 가능.
- [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API): 활성 service worker와 구독, endpoint 보호.
- [Capacitor](https://capacitorjs.com/docs): Android 네이티브 런타임과 plugin 확장.
- [Flutter 지원 플랫폼](https://docs.flutter.dev/reference/supported-platforms): 모바일·데스크톱·웹 대상 구분. 제품별 녹음 plugin 지원은 검증하지 않음.
- [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html): SKIP LOCKED의 큐 소비자 경합 회피 용도와 일반 조회 일관성 한계.
- [FFmpeg](https://ffmpeg.org/ffmpeg.html): filter_threads/filter_complex_threads 설정. CPU/RAM 상한 보장으로 확대 해석하지 않음.

## 미실행과 TASK-43 자체 AC

NOT_RUN: 제품 단위/통합/E2E·브라우저 화면 렌더링·Android/PC 실제 마이크/알림·10분 대화·N100/기존 서비스 부하·외부 계정/가격/유료 호출·DB 장애/백업 복원·사용자 실사용 3회·Wiki/Flowchart 원문 대조. 앱/테스트 manifest가 없는 조사 제출이며 TASK-43은 제품 구현·출시 완료를 요구하지 않는다. 스크린샷은 화면 변경이 없어 해당 없음(visualRequired=false). 격리 DB/Redis 접속도 이번 문서 검수에는 필요하지 않아 실행하지 않았다.

| TASK-43 조건 | 판정 | 근거 |
| --- | --- | --- |
| AC-1. TASK-1의 모든 완료 조건을 실제 문서·커밋·명령 증거와 대조한 검수표가 있다. | PASS | 위 원문 AC 4개 대조표와 실제 Git/문서 검사 |
| AC-2. 제품 제약과 조사 환경의 한계를 확인하고 문제별 근거 또는 이상 없음 근거를 제시한다. | PASS | 제품 제약 표, 환경 제한 및 후속 게이트 |
| AC-3. PASS/CHANGES_REQUESTED/BLOCKED 판정과 실제 검증 범위·미실행 범위가 기록된다. | PASS | 조사 범위 PASS, 실행 증거 및 NOT_RUN 목록 |

배포·원격 push·외부 artifact publication 없음. 최종 승인 대신 Mandu에 실제 검수 보고와 사람 검토 요청을 제출한다.
