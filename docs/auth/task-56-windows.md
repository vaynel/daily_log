# TASK-56 · Windows 로그인 도우미 준비판

**아직 사용자 실행 준비 완료가 아니다.** 기준 커밋 `a36ae5cb7b5315ddcfbcddbee1fe9a84e9be8e70`의 실제 Windows CI는 21 PASS / 0 FAIL / 2 SKIP이며 [검증 기록](task-56-verification.md)에 근거와 한계가 있다. TASK-57 독립 QA 전에는 로그인하지 않는다. `.cmd` 더블클릭·대화형 메뉴 전체는 미검증이다. 실제 사용자 동의·계정 지원·추론 성공은 TASK-4에서 별도 확인한다. 개발 Codex 인증을 읽거나 복사하지 않는다. 배포 없음.

## Windows에서 사용할 때 (검수 후 사용자용)

1. Windows의 **일반 사용자 계정**에서 실행한다. WSL·Android·관리자 권한은 필요하지 않다. 로컬 NTFS 드라이브, Windows PowerShell 5.1, Node.js 22 이상이 필요하다. Node가 없거나 낮으면 시작 창에서 안내하고 종료한다. [Node.js 공식 다운로드](https://nodejs.org/en/download)에서 Windows ZIP을 사용자 폴더에 풀고 `node.exe`가 있는 폴더를 사용자 PATH에 넣는 방법도 있다. 시스템 PATH나 실행 정책을 변경할 필요가 없다.
2. PM이 전달한 ZIP의 SHA256을 PowerShell `Get-FileHash -Algorithm SHA256 .\daily-log-siwc-windows-<commit>.zip`로 확인한다. 별도 신뢰 가능한 전달 경로의 `.sha256` 및 40자리 제출 commit과 비교한다. ZIP과 옆에 있는 체크섬만으로 배포자 신원까지 증명되지는 않는다.
3. 사용자 폴더에 ZIP을 푼다. `start-windows.cmd`를 실행하면 한글 메뉴가 열린다. 저장소/종속성 설치나 `npm install`은 필요 없다. 소스 파일만 포함한다.
4. 기본 선택은 안전한 로컬 데모이다. 표시된 `127.0.0.1` 주소를 **같은 Windows PC의 브라우저**에서 연다. 휴대폰이나 Linux 서버의 브라우저에 복사하지 않는다. 자동 브라우저 실행·자동 로그인은 없다. 창은 10분 후 종료되고 Ctrl+C로 중단할 수 있다.
5. 독립 검수와 이용 조건 확인 후에만 3번과 `LOGIN`을 입력한다. 여기서도 OAuth는 시작되지 않는다. 로컬 페이지의 `Continue with ChatGPT` 또는 `ChatGPT 사용 권한 활성화` 버튼을 직접 눌러야 OpenAI 동의 화면으로 이동한다. 올바른 계정·workspace·앱 권한을 확인하고 원하지 않으면 취소한다.
6. 상태 확인은 비밀값 없이 `WAIT_AUTH`/`WAIT_PERMISSION` 등과 `productConnection: NOT_VERIFIED`, `paidFallback: false`만 표시한다. 계정 저장 성공은 제품 요청 성공이 아니다. 실제 제품 연결은 TASK-4의 사용자 검증 대상이다.

저장은 `%LOCALAPPDATA%\daily-log-siwc`에 한다(한 계정 등록). 저장 폴더는 앱이 생성한다. 미리 생성한 폴더의 ACL이 넓으면 자동으로 고치지 않고 안전하게 중단한다. OneDrive/공유 드라이브/UNC/장치 경로/FAT/재분석 지점 경로는 사용하지 않는다. CLI의 별도 절대 경로는 기존 부모 폴더 아래 `daily-log-siwc` 구성요소를 포함해야 한다. `..`, ADS, 예약 장치 이름, 끝의 점/공백은 거부한다.

PowerShell helper는 `-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned`를 **해당 자식 프로세스에만** 적용한다. 시스템·현재 사용자 실행 정책은 바꾸지 않으며 조직 Group Policy를 우회하지 않는다. 내려받은 파일의 인터넷 표시 때문에 차단되면 ZIP 해시와 helper 소스를 검토한 후, **검증한 해당 ZIP 하나만** `Unblock-File -LiteralPath .\<검증한 ZIP 이름>` 처리하고 새 폴더에 다시 푼다. 조직 정책으로 계속 차단되면 관리자 권한/Bypass로 우회하지 말고 중단하여 PM에게 전달한다. 보안 제품의 PowerShell/C# 차단도 실제 Windows CI와 별도의 사용자 환경 조건이다.

## 저장·삭제·복구

- `session.json`, `host.json` 모두 **DPAPI CurrentUser 암호문**이다. 파일 소유자와 DACL은 현재 Windows SID만 FullControl로 생성한다. 기존 파일/폴더가 다른 SID 또는 넓은 ACL을 허용하면 거부한다. 토큰은 명령 인수·환경변수·콘솔·ZIP에 넣지 않는다. Node↔helper 사이 익명 pipe 안에서만 평문을 전달한다.
- NTFS 고정 드라이브만 허용한다. 각 조상과 저장 폴더를 `OPEN_REPARSE_POINT` 핸들로 열어 재분석 지점을 거부하고, 삭제 공유 없이 유지해 작업 중 이름 변경을 막는다. 파일도 핸들로 유형/링크 수(1)/크기/ACL을 확인한다. 심볼릭 링크·junction·하드링크·잘못된 ACL·DPAPI 복호화 오류는 중단한다.
- `.lock`은 삭제하지 않는 파일이다. 전체 갱신 트랜잭션 동안 독점 Windows 핸들을 유지한다. 다른 프로세스는 BUSY로 실패하며, 프로세스 종료 시 OS가 잠금을 해제한다. 파일 존재만으로 잠겼다고 판단하거나 오래됐다고 잠금을 삭제하지 않는다.
- 새 암호문을 같은 폴더의 고유 임시 파일에 쓰고 `Flush(true)` 후 `MoveFileEx(REPLACE_EXISTING | WRITE_THROUGH)`로 교체한다. 이전 세션을 먼저 truncate하지 않는다. 장애로 남은 `.tmp`도 암호문이다. 로컬 디스크 자체의 손상·백업·완전 삭제까지 보장하지 않는다.
- 메뉴 4번과 `DELETE`는 로컬 세션 파일만 삭제하고 안정적인 host ID를 보존한다. 원격 연결 해지가 아니다. 원격 해지는 사용자가 ChatGPT 설정에서 확인한다. CLI `signout`은 원격 해지를 시도하고 토큰을 제거하며 실패/미확인을 표시한다. 진행 중인 도우미를 종료한 다음 삭제한다.
- **Windows의 암호화 파일은 Linux에 복사/import할 수 없다.** Windows 평문 export/import는 제공하지 않는다. 기존 TASK-53의 Linux SSH 전달 예제를 Windows 파일에 적용하지 않는다. Windows→서버 보안 인계는 후속 설계·검증 대상이며 이번 준비판은 서버 연결을 완료하지 않는다.
- DPAPI와 ACL은 다른 일반 사용자/파일 노출에 대한 보호다. 같은 사용자로 실행되는 악성 코드, 관리자/SYSTEM, OS 계정 탈취까지 방어한다고 주장하지 않는다. DPAPI 사용자 프로필을 잃었을 때 평문 복구·자동 fallback은 없다. 저장 오류는 비밀값 없는 일반 오류로 표시하며 기존 파일을 자동 삭제/덮어써서 복구하지 않는다.

## PM: 재현 가능한 ZIP·검증·인계

제출된 **정확한 commit**을 checkout한 후 Node 22+, Git으로 실행한다:

```sh
node --test scripts/siwc/*.test.mjs
node scripts/package-siwc-windows.mjs
```

`dist/siwc-windows/`에 commit 이름의 ZIP, `.sha256`, `.manifest.json`이 생성된다. builder는 `git archive`로 HEAD의 정확한 12개 허용 파일만 읽는다. 작업 폴더의 untracked 파일, data, .env, 토큰, node_modules는 대상이 아니다. 변경 중인 소스를 패키지에 넣으려면 먼저 commit해야 한다. 동일 commit/Git 버전에서 다시 생성하여 바이트/해시를 비교한다. manifest에 Git 버전과 파일 목록이 있다. 이는 로컬 패키지 생성이며 runner artifact publication이나 공개 배포를 수행하지 않는다.

`.github/workflows/siwc-windows.yml`은 Windows와 Ubuntu에서 Node 22 모의 OAuth·저장소 회귀를 실행한다. Windows 전용 시험은 실제 win32에서만 수행하며 Linux에서는 SKIP이다. POSIX 파일 mode/import 시험 두 건은 Windows에서 SKIP하고 Windows 전용 DPAPI/ACL 시험으로 따로 검사한다. 압축 해제한 한글·공백 경로에서 시작 도우미 preflight도 검사한다. 기존 Linux 전체 `npm run check` CI는 유지한다. OAuth transport는 합성이며 실계정이나 유료 API를 호출하지 않는다.

PM 후속: 최종 문서 커밋·ZIP/체크섬 확인 → TASK-57 독립 QA → 그 뒤 TASK-4 실제 사용자 로그인 검증. [Windows/Ubuntu CI](https://github.com/vaynel/daily_log/actions/runs/39450866093)는 기준 구현 커밋에서 성공했으며 현재 문서 커밋의 실행 소스·테스트·워크플로는 동일하다. Windows 로그에는 Node 부재 `.cmd` 검사와 한글·공백 경로의 Node launcher preflight가 포함되지만 더블클릭·대화형 메뉴 전체 실행은 포함되지 않는다. 필요 시 독립 QA에서 실제 Windows로 추가 확인한다. 최종 ZIP의 문서 갱신에 따른 해시는 기준 구현 ZIP과 다르므로 제출 report와 manifest의 정확한 커밋·해시를 사용한다.

## 확인한 공식 근거

- [OpenAI SIWC OSS 개요](https://developers.openai.com/siwc/token-sharing-open-source): 사용자 소유 OSS/플랜 사용 권한과 identity sign-in 구분. 기존 state/nonce/PKCE/재동의/loopback 정책은 유지한다.
- [Microsoft DataProtectionScope](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope): CurrentUser 범위의 보호/복호화.
- [Microsoft CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [재분석 지점과 파일 작업](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points-and-file-operations): no-follow 검사와 공유 모드 설계 근거.

실제 실행 결과는 `task-56-verification.md`와 Mandu의 제출 보고서를 확인한다. 위 보안 설계는 Windows 실제 시험 통과를 대신하지 않는다.
