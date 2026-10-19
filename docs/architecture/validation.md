# TASK-1 검증 기록

2026-10-19 UTC, `/workspace`의 제공된 격리 checkout에서 실행했다. 실제 호스트·Android 기기를 조사한 기록이 아니다.

## 기준 조사 — 실제 결과

아래 명령들은 각각 exit 0이었다(없는 파일은 존재 검사로 확인).

| 명령 | 결과 |
| --- | --- |
| `git remote -v` | fetch/push 모두 `https://github.com/vaynel/daily_log.git` |
| `git rev-parse HEAD` | `686e92da29b72154182682dced58d8913193975b` |
| `git rev-parse HEAD^{tree}` | `4b825dc642cb6eb9a060e54bf8d69288fbee4904` |
| `git log -1 --format='%H %s'` | 위 commit, `chore: initialize daily log runner baseline` |
| `git ls-tree -r --name-only HEAD`, `git ls-files` | 모두 빈 출력 |
| `git status --porcelain=v1` (수정 전) | 빈 출력 |
| `git branch --show-current` (시작 시) | 빈 출력: detached HEAD |
| `git rev-parse --show-superproject-working-tree` | 빈 출력: submodule 아님 |
| `git rev-parse --git-dir --git-common-dir` | 서로 다른 worktree/common 메타데이터 경로: 기존 격리 공간 |
| `/AGENTS.md`, `/workspace/AGENTS.md` 존재 검사 | 둘 다 absent |
| `rg --files --hidden`로 workspace 조사 | 작업 전 제품 파일 없음 |

`/run/mandu/MANDU-HANDOFF.json`의 seed commit/tree를 위 실제 결과와 대조했다. 불변 입력 파일은 수정하지 않았다. 호스트의 미추적 문서는 번들에 없어 확인하지 않았다. Wiki/Flowchart 조회 도구가 scoped Mandu 목록에 없고 원문도 입력에 없어 원문 대조는 NOT_RUN이다.

## 산출물 검증과 재현

QA는 제출 commit checkout에서 다음 명령으로 내용과 기준을 재확인할 수 있다. 명령은 제품 기능 테스트가 아니다.

```sh
git remote get-url origin
git cat-file -t 686e92da29b72154182682dced58d8913193975b
git ls-tree -r 686e92da29b72154182682dced58d8913193975b
git diff --check 686e92da29b72154182682dced58d8913193975b HEAD
git show --stat --oneline HEAD
git status --porcelain=v1
```

수동 설계 검토 항목: D01-01~04와 AC-1~4의 근거 위치, 지원 목표와 미검증 기기 구분, 예산 대기와 유료 자동 전환 금지, 단일 렌더·종료 미확인 대기, 재시도/재제작 카운터 분리, 기존 서비스 격리, 포트 후보의 미확정 표시, 롤백 시 원장·삭제 정합성. 검토 범위는 [설계 문서](initial-assessment.md)이며 독립 QA 검수와 다르다.

제품 테스트·실기기·서버 렌더 시험은 NOT_RUN이다. 실행할 제품이나 테스트 manifest가 없으며 TASK-1은 조사·설계 범위다. 문서 존재만 검사하는 형식적 테스트 코드를 새로 만들지 않았다. 브라우저 화면 변경이 없어 스크린샷은 해당 없음이다.

## 제출 전 실제 점검 결과

- `git switch -c task-1-initial-assessment`: exit 0, 제공된 격리 checkout에서 제출 브랜치 생성.
- 두 문서를 stage한 후 `git diff --cached --check`: exit 0, 공백 오류 없음.
- `git diff --cached --stat`: 문서 두 개만 추가됨. 전체 문서를 다시 읽고 위 수동 설계 검토 항목과 AC 4개를 대조했다. 조사·설계 범위 PASS이며 미검증 기능은 문서 §3/§6에 분리했다.
- Python 표준 라이브러리로 UTF-8 디코딩, Markdown 코드 fence 쌍, 상대 링크 대상 존재를 일회 점검: exit 0, 두 문서 모두 `UTF-8, balanced fences, local links OK`. Markdown/Mermaid 실제 화면 렌더링 시험은 하지 않았다.
- 최초 `git diff --no-index --check /dev/null ...`는 새 파일 차이로 exit 1·출력 없음이었고 `&&` 뒤 명령은 실행되지 않았다. 이를 통과로 세지 않고 위 staged diff 검사로 대체했다.
- 최초 commit 시도는 Git 작성자 설정 없음으로 exit 128이었다. 전역 설정을 바꾸지 않고 commit 명령에만 `user.name=Mandu Worker`, `user.email=mandu-worker@localhost`를 지정하여 작업자 작성자를 명시한다.
- 기능 테스트, 서버/실기기 시험, 유료 호출, 배포는 실행하지 않았다. 코드 없는 조사 Task의 문서 검증 결과를 제품 테스트 PASS로 해석하지 않는다.

최종 40자리 제출 commit은 이 파일을 포함하는 Git commit 및 Mandu의 불변 report에서 확인한다(파일 안에 자기 commit을 삽입하지 않는다). artifact publication은 외부 러너 책임이며 worker가 수행하지 않는다.
