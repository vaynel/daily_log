# TASK-48 테스트 의존성 보완

2026-10-20 조사. 기준: `0962c94ba0ce34200ba1105ddcac9f566be0c336`.
범위는 테스트 도구 의존성 보완이며 운영 배포·공격 재현은 수행하지 않았다.

## 설치 버전과 노출 조건

`npm ci` 후 `npm ls vitest @vitest/mocker tinypool --json`과 `npm audit --json`으로 확인했다. audit의 critical 2건은 독립적인 제품 취약점 2건이라는 의미가 아니다. 상위 vitest에 전이된 심각도가 포함된다.

| 패키지 | 이전 → 이후 | 공식 advisory / 수정 | 프로젝트 노출 분석 |
| --- | --- | --- | --- |
| vitest | 3.2.7 → 4.1.11 | [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), 4.1.11 수정. 3.x 수정 계획 없음 | 두 workspace의 devDependency, `vitest run`만 실행. critical 표시는 tinypool 영향도 포함. |
| @vitest/mocker | 3.2.7 → 4.1.11 | 위 advisory: redirect mock 경로 검증 누락 | unauthenticated 경로는 standalone mocker/interceptor 플러그인이 접근 가능한 Vite HMR에 등록될 때. 이 저장소의 vite.config.ts는 React 플러그인만 사용하고 127.0.0.1에 바인딩. browser mode/standalone mocker 사용 없음. 이 코드 검토상 원격 노출 경로는 관찰되지 않았지만 영향 버전은 교체함. |
| tinypool | 1.1.1 → 의존 트리에서 제거 | [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3): worker 옵션 prototype lookup, 2.1.1 수정. [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr): run 옵션 filename lookup, 2.1.2 수정 | 공격자가 먼저 prototype을 오염시킬 수 있어야 하는 gadget. 후자는 run에 옵션 객체를 넘기는 경로가 조건. 제품 서버/worker는 tinypool을 import하지 않음. 이전에는 테스트 실행 프로세스의 전이 의존성. 개발·CI 위험을 운영 API 취약점으로 확대하지 않음. |

이는 설치 트리와 코드에 근거한 노출 평가이며 악용 불가능함의 증명은 아니다.

## 최소 변경 선택

두 workspace에서 `vitest: "4.1.11"`로 고정했다. 보안 수정이 있는 가장 낮은 stable major로 올려 관련 mocker도 함께 맞췄다. npm audit이 제안하는 Vitest 5 강제 갱신이나 mocker/tinypool의 비호환 override는 사용하지 않았다. Vitest 4 자체가 tinypool을 사용하지 않아 두 critical advisory의 해당 의존성을 제거한다. Vite는 기존 7.3.7, 제품 runtime dependency 버전은 유지했다.

[Vitest 4 migration guide](https://v4.vitest.dev/guide/migration.html)를 확인했다. 기존 Node 22와 Vite 7이 요구 조건을 만족한다. 이 프로젝트에는 coverage, custom pool, mock/spy, snapshot 설정이 없다. 서버 build는 test 파일을 제외하므로 v4의 기본 dist 제외 제거로 중복 테스트가 생기지 않는다. API/config 기존 4개 테스트를 그대로 검증했다.

npm 10.9.9의 install/lockfile 생성은 Arborist `edgesOut` null 오류로 실패했다. npm 11.21.1의 lockfile 생성으로 해결했고, 생성된 lockfile은 npm 10.9.9 `npm ci`로 재설치에 성공했다. npm 자체나 프로젝트 엔진 요구사항을 변경하지 않았다.

재현 명령(업데이트가 필요한 경우):

```sh
# 먼저 두 workspace manifest를 vitest 4.1.11로 변경
npm exec --yes --cache /workspace/data/npm-cache --package npm@11.21.1 -- npm install --package-lock-only --ignore-scripts --cache /workspace/data/npm-cache
npm ci --cache /workspace/data/npm-cache
npm run check
npm run scan:secrets
npm audit --json
npm ls vitest @vitest/mocker tinypool --json
```

## 검증 및 남은 조건

커밋 전 npm ci, lint, typecheck, test, build 모두 exit 0. 서버 테스트 4개 통과; 웹에는 테스트가 없으며 `--passWithNoTests`로 종료한다. 첨부 audit JSON은 변경 전 critical 2/moderate 1에서 변경 후 전체 0으로 변했다. 알려진 advisory 잔여 항목은 없다. audit 0건이 보안 무결함을 뜻하지 않는다. eslint 9.39.5 지원 종료 경고는 이번 보안 수정과 무관한 major 전환이므로 별도 후속 사항이다.

동일 제출 commit 재검증 로그는 `/workspace/data/task48/`에 보존하고 Mandu report에 실제 40자리 SHA와 검사 결과를 기록한다. 이 문서의 커밋 전 결과를 GitHub CI 통과로 간주하지 않는다. Git HTTPS push dry-run은 인증 부재로 실패했고, 연결된 GitHub 도구도 create_tree 요청에 403 Resource not accessible by integration을 반환했다. 따라서 push/PR 생성 및 신규 commit의 CI 실행은 미실행이다. AC-3는 로컬 검사만 완료한 PARTIAL로 보고한다. PM은 `task-48/dependency-security` 브랜치의 제출 commit을 push하고 main 대상 PR을 생성한 뒤 같은 head_sha의 CI 성공을 확인해야 한다. 독립 QA와 PM 승인이 남아 있으며 운영 배포는 하지 않는다.
