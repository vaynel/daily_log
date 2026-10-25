// 로컬 확인 전용: 모의 OIDC 발급자 + 서버를 띄운다. 실제 Google 과 통신하지 않으며 값은 모두 합성이다.
//   npm run dev:auth-demo -w apps/server   (웹은 npm run dev:web, http://127.0.0.1:5173)
import { buildApp } from '../app.js';
import { loadAuthConfig } from './config.js';
import { startMockIssuer } from './mock-issuer.js';
import { createPool } from '../db/pool.js';
import { RecordStore } from '../records/store.js';
import { NotificationService } from '../notify/service.js';
import { UnconfiguredSender } from '../notify/sender.js';

const issuer = await startMockIssuer({ clientId: 'demo-client', clientSecret: 'demo-secret-not-real' });
issuer.state.account = { sub: 'demo-owner', email: process.env.DEMO_LOGIN_EMAIL ?? 'owner@example.test', email_verified: true, name: 'Demo Owner' };
const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'demo-client', GOOGLE_CLIENT_SECRET: 'demo-secret-not-real', GOOGLE_ISSUER: issuer.issuer, ALLOWED_EMAILS: 'owner@example.test', PUBLIC_BASE_URL: 'http://127.0.0.1:5173', APP_URL: 'http://127.0.0.1:5173/' })!;
// DATABASE_URL 이 있으면 기록·첨부 API 도 켠다(마이그레이션 적용 필요). 파일은 FILE_STORAGE_DIR(기본 /tmp)에 저장.
const pool = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : undefined;
const records = pool ? new RecordStore(pool) : undefined;
const notifications = pool ? new NotificationService({ pool, sender: new UnconfiguredSender() }) : undefined;
const app = buildApp({ records, notifications, auth, sessionSecret: 'demo-session-secret-not-real-0000', fileStorageDir: process.env.FILE_STORAGE_DIR ?? '/tmp', entries: { list: async () => [{ id: '1', body: '합성 예시 기록' }] } });
await app.listen({ port: 3000, host: '127.0.0.1' });
console.log('auth demo ready (mock issuer', issuer.issuer, ')');
