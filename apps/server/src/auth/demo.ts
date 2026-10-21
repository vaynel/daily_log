// 로컬 확인 전용: 모의 OIDC 발급자 + 서버를 띄운다. 실제 Google 과 통신하지 않으며 값은 모두 합성이다.
//   npm run dev:auth-demo -w apps/server   (웹은 npm run dev:web, http://127.0.0.1:5173)
import { buildApp } from '../app.js';
import { loadAuthConfig } from './config.js';
import { startMockIssuer } from './mock-issuer.js';

const issuer = await startMockIssuer({ clientId: 'demo-client', clientSecret: 'demo-secret-not-real' });
issuer.state.account = { sub: 'demo-owner', email: process.env.DEMO_LOGIN_EMAIL ?? 'owner@example.test', email_verified: true, name: 'Demo Owner' };
const auth = loadAuthConfig({ GOOGLE_CLIENT_ID: 'demo-client', GOOGLE_CLIENT_SECRET: 'demo-secret-not-real', GOOGLE_ISSUER: issuer.issuer, ALLOWED_EMAILS: 'owner@example.test', PUBLIC_BASE_URL: 'http://127.0.0.1:5173', APP_URL: 'http://127.0.0.1:5173/' })!;
const app = buildApp({ auth, sessionSecret: 'demo-session-secret-not-real-0000', fileStorageDir: '/tmp', entries: { list: async () => [{ id: '1', body: '합성 예시 기록' }] } });
await app.listen({ port: 3000, host: '127.0.0.1' });
console.log('auth demo ready (mock issuer', issuer.issuer, ')');
