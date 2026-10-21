# TASK-58 · Windows 로그인 후 headless Linux 서버 연결

**독립 검수 전 준비판이다. 검수가 끝나기 전에 사용자에게 실행을 요청하지 않는다.** 실제 계정 지원, 제품 요청 성공, Windows→Linux 실전달 성공은 모두 미검증(TASK-4)이다. 개발용 Codex 인증은 읽거나 재사용하지 않는다. 배포·유료 호출 없음.

## 현재 상태 기록
- 사용자 보고(2026-10-22 KST, 로컬 파일 직접 확인 아님): Windows에서 "앱 전용 동의 검증·저장됨 — 제품 연결 검증은 아직 미완료"가 표시되었다. 이는 사용자 보고이며 서버 쪽 확인이 아니다. 이미 저장된 인증은 삭제하거나 다시 로그인시키지 않는다(만료·권한 부족일 때만 재로그인).

## 공식 근거 (2026-10-21 직접 조회)
[Self-hosted VM](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms): 로컬에서 OAuth를 마친 뒤 보호된 자격증명을 SSH 등 안전한 채널로 VM에 전달, VM 고유 `ext_agent_host_id` 보존(노트북 ID로 덮어쓰지 않음), 이후 갱신은 VM이 소유. 이전된 세션의 host별 사용량 귀속·플랜 접근 해지는 아직 제공되지 않는다. `127.0.0.1` 콜백은 서버가 아니라 로컬 브라우저에 도달한다.

## 구현
- Windows 시작 메뉴 **5: 서버로 안전 전달** → `siwc-cli handoff`. 입력: `USER@HOST`, 서버 공개 호스트키(`ssh-ed25519 AAAA…`), 서버의 daily_log 절대 경로, 서버 SIWC 저장 절대 경로. 비밀번호·토큰은 묻지 않는다.
- 서버 신원은 사용자가 서버에서 확인한 **공개 호스트키로 고정**한다(임시 known_hosts, `StrictHostKeyChecking=yes`, 전역 known_hosts 미사용, `BatchMode`, 포워딩 제거). 키가 다르면 전송 전에 ssh가 실패한다.
- 사용자가 `SEND`를 입력한 경우에만 진행한다. 세션은 DPAPI 저장소에서 읽어 **ssh stdin**으로만 전달한다(인수·환경변수·로그·파일 없음). 서버는 `import --stdin`으로 서명·issuer·audience·subject·만료를 재검증하고 서버 자체 host ID를 유지한다.
- 서버가 `CREDENTIALS_IMPORTED_PRODUCT_NOT_VERIFIED` 또는 `CREDENTIALS_ALREADY_CURRENT`를 확인한 뒤에만 Windows 로컬 세션을 삭제한다(host ID 보존). 이중 갱신 방지.
- 실패·무응답·확인 불가: 로컬 세션 유지. 응답 유실 후 재시도는 서버가 이미 있는 같은 계정 세션을 덮어쓰지 않고 `ALREADY_CURRENT`로 응답하므로 중복 갱신이 없다.
- 만료(access 60초 미만)·권한 부족(`WAIT_PERMISSION`)·미로그인 상태는 전달하지 않고 재로그인/권한 활성화를 안내한다. 다른 계정이 이미 있는 서버는 거부한다.
- 완료 화면 안내는 상태·플랫폼별이다(`nextStep`). 추가 공개 포트·유료 fallback 없음.

## 사용자 절차 (검수 후, 이미 로그인한 Windows 사용자)
1. 서버에서(관리자가 한 번): daily_log 설치, `npm run siwc -- init --dir <서버 저장 경로>`, `cat /etc/ssh/ssh_host_ed25519_key.pub`의 첫 두 단어 확인.
2. Windows 키 기반 SSH(`ssh USER@HOST`로 비밀번호 없이 접속)가 되는지 확인. 필요한 추가 행동은 이것뿐이며 다시 로그인하지 않는다.
3. `start-windows.cmd` → 5 → 위 네 값 입력 → `SEND`.
4. 서버에서 `npm run siwc -- status --dir <서버 저장 경로>`로 `credentials: READY`, `productConnection: NOT_VERIFIED` 확인.

## TASK-4 최소 제품 요청 (비밀값 없음)
서버에서 `infer`(supportVerified는 서버 내부 TASK-4 근거로만 설정)를 모델·짧은 텍스트 하나로 1회 호출하고, 기록은 상태(`SUCCEEDED`/`WAIT_*`)·호출 수·길이만 남긴다. 실패 시 자동 재시도·유료 전환 없음. 이 Task에서는 실행하지 않았다.

## 한계
host별 사용량·해지 미제공(공식). Windows OpenSSH 클라이언트 필요. Windows에서 실제 ssh 전달은 NOT_RUN(모의 pipe만 검증). 동일 사용자 악성코드·관리자 위협은 방어하지 않는다.
