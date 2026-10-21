import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadAuthConfig, type AuthConfig } from './config.js';
import { startMockIssuer } from './mock-issuer.js';
import { sign } from './session.js';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret-value';
const SECRET = 'unit-test-session-secret-0123456789';
const OWNER = { sub: 'sub-owner', email: 'owner@example.test', email_verified: true, name: 'Owner' };
const STRANGER = { sub: 'sub-stranger', email: 'stranger@example.test', email_verified: true, name: 'Stranger' };

let issuer: Awaited<ReturnType<typeof startMockIssuer>>;
let dir: string;
let cfg: AuthConfig;
let app: FastifyInstance;

const cookieOf = (setCookie: string | string[] | undefined, name: string) => {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const hit = list.find((c) => c.startsWith(`${name}=`));
  return hit?.split(';')[0]?.slice(name.length + 1) ?? '';
};

/** 브라우저가 하는 일을 흉내: /auth/login → 발급자 authorize → /auth/callback. 세션 쿠키 값과 최종 이동 주소를 돌려준다. */
async function signIn(account = OWNER) {
  issuer.state.account = account;
  const start = await app.inject('/auth/login');
  expect(start.statusCode).toBe(302);
  const flow = cookieOf(start.headers['set-cookie'], 'dl_flow');
  const authz = await fetch(start.headers.location as string, { redirect: 'manual' });
  expect(authz.status).toBe(302);
  const cb = new URL(authz.headers.get('location')!);
  const res = await app.inject({ method: 'GET', url: cb.pathname + cb.search, headers: { cookie: `dl_flow=${flow}` } });
  const list = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return { res, session: cookieOf(list, 'dl_session'), location: res.headers.location as string };
}

const withSession = (session: string) => ({ cookie: `dl_session=${session}` });

beforeAll(async () => {
  issuer = await startMockIssuer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  dir = await mkdtemp(path.join(os.tmpdir(), 'dl-auth-'));
  await mkdir(path.join(dir, 'attachments'));
  await mkdir(path.join(dir, 'videos'));
  await writeFile(path.join(dir, 'attachments', 'photo.png'), 'PNGDATA');
  await writeFile(path.join(dir, 'videos', 'day1.mp4'), 'MP4DATA');
  await writeFile(path.join(dir, 'secret.txt'), 'outside-of-served-dirs');
  cfg = loadAuthConfig({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_ISSUER: issuer.issuer, ALLOWED_EMAILS: ' Owner@Example.test ', PUBLIC_BASE_URL: 'http://localhost:3000' })!;
  app = buildApp({ auth: cfg, sessionSecret: SECRET, fileStorageDir: dir, entries: { list: async () => [{ id: 1, body: '개인 기록' }] } });
});

afterAll(async () => {
  await app.close();
  await issuer.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  issuer.state.tamper = {};
  issuer.state.denyDrive = false;
});

describe('AC-1 허용 계정 로그인 후 개인 기록 접근 (인증 E2E, 모의 OIDC)', () => {
  it('로그인 → 기록·첨부·영상 조회 → 로그아웃', async () => {
    const { res, session, location } = await signIn(OWNER);
    expect(res.statusCode).toBe(302);
    expect(location).toBe('/');
    expect(session).not.toBe('');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const me = await app.inject({ url: '/auth/session', headers: withSession(session) });
    expect(me.json()).toEqual({ email: 'owner@example.test', name: 'Owner', driveConnected: false });

    const entries = await app.inject({ url: '/api/entries', headers: withSession(session) });
    expect(entries.statusCode).toBe(200);
    expect(entries.json()).toEqual({ entries: [{ id: 1, body: '개인 기록' }] });
    expect(entries.headers['cache-control']).toContain('no-store');

    const file = await app.inject({ url: '/api/attachments/photo.png', headers: withSession(session) });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('PNGDATA');
    expect(file.headers['content-type']).toBe('image/png');
    const video = await app.inject({ url: '/api/videos/day1.mp4', headers: withSession(session) });
    expect(video.statusCode).toBe(200);
    expect(video.headers['content-type']).toBe('video/mp4');

    const out = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('요청 파라미터: PKCE S256, state, nonce, 로그인 scope 는 openid email profile 만', async () => {
    issuer.state.authorizeRequests.length = 0;
    await signIn(OWNER);
    const q = issuer.state.authorizeRequests[0]!;
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('nonce')).toBeTruthy();
    expect(q.get('state')).toBeTruthy();
    expect(q.get('scope')).not.toContain('drive');
  });

  it('허용 목록 이메일은 대소문자·공백과 무관하게 일치한다', () => {
    expect(cfg.allowedEmails).toEqual(['owner@example.test']);
  });

  it('경로 이동·숨김 파일·허용 폴더 밖 파일은 로그인 상태에서도 받을 수 없다', async () => {
    const { session } = await signIn(OWNER);
    for (const u of ['/api/attachments/..%2Fsecret.txt', '/api/attachments/%2e%2e%2Fsecret.txt', '/api/videos/.env', '/api/attachments/a%2Fb']) {
      const r = await app.inject({ url: u, headers: withSession(session) });
      expect([400, 404]).toContain(r.statusCode);
      expect(r.body).not.toContain('outside-of-served-dirs');
    }
    expect((await app.inject({ url: '/api/attachments/missing.png', headers: withSession(session) })).statusCode).toBe(404);
  });
});

describe('AC-2 비로그인 요청 차단 (API 접근 시험)', () => {
  it.each(['/api/entries', '/api/attachments/photo.png', '/api/videos/day1.mp4', '/api/unknown-future-route', '/api/attachments/..%2Fsecret.txt', '/%61pi/entries', '/%61pi/attachments/photo.png', '/%61pi/videos/day1.mp4', '/%2561pi/entries', '/api%2Fentries', '/%41pi/entries', '//api/entries', '/api/entries;x', '/%2e/api/entries', '/nope', '/healthz/../api/entries', '/auth%2Fsession/../../api/entries'])('쿠키 없음: %s → 401', async (url) => {
    const r = await app.inject(url);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'unauthenticated' });
    expect(r.body).not.toContain('PNGDATA');
    expect(r.body).not.toContain('MP4DATA');
  });

  it('위조·변조된 세션 쿠키는 401', async () => {
    const { session } = await signIn(OWNER);
    const tampered = session.slice(0, -2) + (session.endsWith('A') ? 'BB' : 'AA');
    for (const bad of [tampered, 'garbage', sign({ sub: 'x', email: 'owner@example.test', iat: 1, exp: 9999999999 }, 'wrong-secret-wrong-secret', 'session'), sign({ sub: 'x', email: 'owner@example.test', iat: 1, exp: 9999999999 }, SECRET, 'flow')]) {
      const r = await app.inject({ url: '/api/videos/day1.mp4', headers: withSession(bad) });
      expect(r.statusCode).toBe(401);
    }
  });

  it('인증 설정이 없으면 보호 경로는 모두 503 으로 차단(fail closed)', async () => {
    const closed = buildApp({ auth: null, sessionSecret: SECRET, fileStorageDir: dir });
    expect((await closed.inject('/api/entries')).statusCode).toBe(503);
    expect((await closed.inject('/api/videos/day1.mp4')).statusCode).toBe(503);
    expect((await closed.inject('/healthz')).statusCode).toBe(200);
    await closed.close();
  });
});

describe('AC-3 비허용 Google 계정 (계정 경계 시험)', () => {
  it('비허용 계정은 Google 인증에 성공해도 세션이 발급되지 않고 안내 화면으로 이동한다', async () => {
    const { res, session, location } = await signIn(STRANGER);
    expect(session).toBe('');
    expect(location).toBe('/login?error=not_allowed');
    expect(res.headers['set-cookie']).not.toContain('dl_session=ey');
  });

  it('비허용 계정은 파일 주소를 알아도 접근할 수 없다', async () => {
    const { session } = await signIn(STRANGER);
    for (const u of ['/api/attachments/photo.png', '/api/videos/day1.mp4', '/api/entries']) {
      const r = await app.inject({ url: u, headers: withSession(session) });
      expect(r.statusCode).toBe(401);
      expect(r.body).not.toMatch(/PNGDATA|MP4DATA|개인 기록/);
    }
  });

  it('유효한 서명의 세션이라도 이메일이 허용 목록에 없으면 403 (허용 해제 즉시 반영)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = sign({ sub: 'sub-stranger', email: STRANGER.email, iat: now, exp: now + 600 }, SECRET, 'session');
    for (const u of ['/api/attachments/photo.png', '/api/videos/day1.mp4', '/api/entries', '/auth/session']) {
      const r = await app.inject({ url: u, headers: withSession(token) });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: 'account_not_allowed' });
    }
  });

  it('email_verified 가 아닌 허용 이메일은 거부', async () => {
    const { session, location } = await signIn({ ...OWNER, email_verified: false });
    expect(session).toBe('');
    expect(location).toBe('/login?error=not_allowed');
  });

  it.each([
    ['다른 audience', { aud: 'other-client' }],
    ['nonce 불일치', { nonce: 'replayed' }],
    ['만료된 id_token', { expOffsetSeconds: -60 }],
    ['다른 키로 서명', { signWithOtherKey: true }],
    ['다른 issuer', { iss: 'https://evil.example' }],
    ['alg 가 RS256 아님', { alg: 'none' }],
  ])('id_token 검증 실패(%s) 시 세션 없음', async (_n, tamper) => {
    issuer.state.tamper = tamper;
    const { session, location } = await signIn(OWNER);
    expect(session).toBe('');
    expect(location).toBe('/login?error=login_failed');
  });

  it('state 불일치·flow 쿠키 없음·재사용된 code 는 거부', async () => {
    const start = await app.inject('/auth/login');
    const flow = cookieOf(start.headers['set-cookie'], 'dl_flow');
    const authz = await fetch(start.headers.location as string, { redirect: 'manual' });
    const cb = new URL(authz.headers.get('location')!);
    const good = cb.pathname + cb.search;
    const badState = good.replace(/state=[^&]+/, 'state=forged');
    expect((await app.inject({ url: badState, headers: { cookie: `dl_flow=${flow}` } })).headers.location).toBe('/login?error=login_failed');
    expect((await app.inject(good)).headers.location).toBe('/login?error=login_failed');
    const ok = await app.inject({ url: good, headers: { cookie: `dl_flow=${flow}` } });
    expect(ok.headers.location).toBe('/');
    const again = await app.inject({ url: good, headers: { cookie: `dl_flow=${flow}` } });
    expect(again.headers.location).toBe('/login?error=login_failed');
  });
});

describe('D10-03 세션 만료', () => {
  it('만료된 세션은 session_expired 로 구분되어 401', async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = sign({ sub: 'sub-owner', email: OWNER.email, iat: past - 100, exp: past }, SECRET, 'session');
    for (const u of ['/auth/session', '/api/entries', '/api/videos/day1.mp4']) {
      const r = await app.inject({ url: u, headers: withSession(token) });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'session_expired' });
    }
  });

  it('세션 수명은 설정 값을 따른다', async () => {
    const short = buildApp({ auth: { ...cfg, sessionTtlSeconds: 1 }, sessionSecret: SECRET, fileStorageDir: dir });
    issuer.state.account = OWNER;
    const start = await short.inject('/auth/login');
    const flow = cookieOf(start.headers['set-cookie'], 'dl_flow');
    const authz = await fetch(start.headers.location as string, { redirect: 'manual' });
    const cb = new URL(authz.headers.get('location')!);
    const res = await short.inject({ url: cb.pathname + cb.search, headers: { cookie: `dl_flow=${flow}` } });
    const session = cookieOf(res.headers['set-cookie'], 'dl_session');
    expect((await short.inject({ url: '/auth/session', headers: withSession(session) })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await short.inject({ url: '/auth/session', headers: withSession(session) })).json()).toEqual({ error: 'session_expired' });
    await short.close();
  });
});

describe('AC-4 Drive 동의와 로그인 동의 분리 (동의 분리 시험)', () => {
  it('Drive 미연결 상태에서도 로그인이 성공하고 기록에 접근한다', async () => {
    issuer.state.authorizeRequests.length = 0;
    const { session } = await signIn(OWNER);
    expect(issuer.state.authorizeRequests.map((q) => q.get('scope'))).toEqual(['openid email profile']);
    const me = await app.inject({ url: '/auth/session', headers: withSession(session) });
    expect(me.json()).toMatchObject({ driveConnected: false });
    expect((await app.inject({ url: '/api/entries', headers: withSession(session) })).statusCode).toBe(200);
  });

  it('Drive 연결은 별도 경로·별도 scope 로 요청되고 로그인 사용자만 시작할 수 있다', async () => {
    expect((await app.inject('/auth/drive/connect')).statusCode).toBe(401);
    const { session } = await signIn(OWNER);
    issuer.state.authorizeRequests.length = 0;
    const start = await app.inject({ url: '/auth/drive/connect', headers: withSession(session) });
    expect(start.statusCode).toBe(302);
    const flow = cookieOf(start.headers['set-cookie'], 'dl_flow');
    const authz = await fetch(start.headers.location as string, { redirect: 'manual' });
    const q = issuer.state.authorizeRequests[0]!;
    expect(q.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(q.get('scope')).not.toContain('openid');
    expect(q.get('redirect_uri')).toBe('http://localhost:3000/auth/drive/callback');
    expect(q.get('login_hint')).toBe('owner@example.test');
    const cb = new URL(authz.headers.get('location')!);
    const done = await app.inject({ url: cb.pathname + cb.search, headers: { ...withSession(session), cookie: `dl_session=${session}; dl_flow=${flow}` } });
    expect(done.headers.location).toBe('/?drive=connected');
    const upgraded = cookieOf(done.headers['set-cookie'], 'dl_session');
    const me = await app.inject({ url: '/auth/session', headers: withSession(upgraded) });
    expect(me.json()).toMatchObject({ driveConnected: true });
  });

  it('Drive 동의를 거부해도 로그인 상태와 기록 접근은 유지된다', async () => {
    const { session } = await signIn(OWNER);
    issuer.state.denyDrive = true;
    const start = await app.inject({ url: '/auth/drive/connect', headers: withSession(session) });
    const flow = cookieOf(start.headers['set-cookie'], 'dl_flow');
    const authz = await fetch(start.headers.location as string, { redirect: 'manual' });
    const cb = new URL(authz.headers.get('location')!);
    const done = await app.inject({ url: cb.pathname + cb.search, headers: { cookie: `dl_session=${session}; dl_flow=${flow}` } });
    expect(done.headers.location).toBe('/?drive=denied');
    expect(cookieOf(done.headers['set-cookie'], 'dl_session')).toBe('');
    expect((await app.inject({ url: '/auth/session', headers: withSession(session) })).json()).toMatchObject({ driveConnected: false });
    expect((await app.inject({ url: '/api/entries', headers: withSession(session) })).statusCode).toBe(200);
  });

  it('로그인 flow 쿠키로는 Drive 콜백을, Drive flow 쿠키로는 로그인 콜백을 완료할 수 없다', async () => {
    const { session } = await signIn(OWNER);
    const start = await app.inject({ url: '/auth/drive/connect', headers: withSession(session) });
    const driveFlow = cookieOf(start.headers['set-cookie'], 'dl_flow');
    const authz = await fetch(start.headers.location as string, { redirect: 'manual' });
    const cb = new URL(authz.headers.get('location')!);
    const wrong = await app.inject({ url: '/auth/callback' + cb.search, headers: { cookie: `dl_flow=${driveFlow}` } });
    expect(wrong.headers.location).toBe('/login?error=login_failed');
  });
});
