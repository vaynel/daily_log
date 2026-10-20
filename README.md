# Daily Log

개발 기반 구성(TASK-8). 구조: `apps/web`(React+Vite PWA 골격) · `apps/server`(Fastify API + worker + PostgreSQL 마이그레이션). 기술 선택 근거는 [docs/architecture/initial-assessment.md](docs/architecture/initial-assessment.md).

## 요구 사항
- Node.js 22 이상(`.nvmrc`), npm 10+
- PostgreSQL 15+ 개발용 인스턴스(운영·Mandu·n8n 인스턴스 재사용 금지)

## 설치와 실행
```sh
npm ci
cp .env.example .env     # 값을 로컬 개발용으로 수정. .env 는 커밋 금지
set -a; . ./.env; set +a # 서버는 환경변수만 읽는다(.env 자동 로드 없음)
npm run db:migrate       # 초기 마이그레이션 (idempotent)
npm run db:seed          # 선택: 합성 샘플 1건
npm run dev:server       # API  http://127.0.0.1:3000/healthz
npm run dev:worker       # 작업자 골격 (DB heartbeat만 수행)
npm run dev:web          # 웹   http://127.0.0.1:5173 (/healthz 는 API로 프록시)
```
필수 환경변수(`DATABASE_URL`, `FILE_STORAGE_DIR`, `SESSION_SECRET`)가 없으면 누락 항목(값 제외)을 출력하고 종료 코드 78로 종료한다.

## 검증
```sh
npm run check        # lint + typecheck + test + build
npm run scan:secrets # 추적/신규 파일의 비밀값 패턴 검사
```
CI(`.github/workflows/ci.yml`)는 같은 검사와 빈 PostgreSQL에 대한 마이그레이션·시드를 실행한다.

## 초기화
- 개발 DB 초기화: 개발 DB 삭제 후 재생성 → `npm run db:migrate`. (`DROP DATABASE` 는 개발 인스턴스에서만 직접 수행)
- 로컬 파일 초기화: `rm -rf data/files` (개발 데이터 한정; `data/.gitkeep` 유지)
- 의존성 초기화: `rm -rf node_modules && npm ci`

## 롤백
- 코드: 이전 commit 으로 `git revert` 또는 checkout 후 `npm ci`.
- 스키마: 마이그레이션은 앞으로만 적용(`schema_migrations` 기록). down 마이그레이션은 제공하지 않으며 자동 destructive 롤백을 하지 않는다. 문제가 있으면 개발 DB는 재생성하고, 이후 환경은 백업 복원 절차(후속 OPS Task)를 따른다.

## 보안
`.env`, `data/*` 는 git 에서 제외된다. 로그·문서·커밋에 실제 키·토큰·개인 원문을 넣지 않는다. `.env.example` 값은 자리표시이다.

## 알려진 한계 (이 Task 범위 밖)
인증·기록 스키마·작업 큐·렌더러·Redis 사용은 후속 Task. 운영 배포 구성 없음.

## 앱 전용 ChatGPT 로그인 준비 (TASK-53)
[SIWC 도우미 실행·보호 저장·서버 전달 안내](docs/auth/task-53-siwc.md).
`npm run siwc -- help`, `npm run test:siwc`. 기본 데모는 외부 요청 없음.
실제 제품 계정 동의·요청 검증은 TASK4 후속이며 개발 Codex 인증과 분리한다.
