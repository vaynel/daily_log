import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DRIVE_SCOPE, LOGIN_SCOPE, type AuthConfig } from './config.js';
import { b64url, challengeOf, OidcClient, OidcError } from './oidc.js';
import { parseCookies, serializeCookie, sign, verify, type SessionClaims } from './session.js';

const SESSION_COOKIE = 'dl_session';
const FLOW_COOKIE = 'dl_flow';
const FLOW_TTL_S = 600;

interface Flow {
  kind: 'login' | 'drive';
  state: string;
  nonce: string;
  verifier: string;
  /** drive 흐름에서 동의를 요청한 로그인 사용자 */
  sub?: string;
  exp: number;
}

export interface EntryStore {
  list(): Promise<unknown[]>;
}

export interface AuthPluginOptions {
  auth: AuthConfig | null;
  sessionSecret: string;
  fileStorageDir: string;
  entries: EntryStore;
  fetchImpl?: typeof fetch;
}

export type AuthFailure = { status: 401 | 403 | 503; code: 'unauthenticated' | 'session_expired' | 'account_not_allowed' | 'auth_not_configured' };

/**
 * 인증 + 보호 자원. /healthz·/auth/** 외 모든 경로는 전역 onRequest 훅에서 동일한 검사를 거친다(새 라우트도 기본 차단).
 * 세션은 서명 쿠키이며, 허용 계정 여부는 요청마다 다시 확인한다(허용 목록에서 빠지면 즉시 차단).
 */
export function registerAuth(app: FastifyInstance, opts: AuthPluginOptions) {
  const { auth, sessionSecret } = opts;
  const oidc = auth ? new OidcClient(auth, opts.fetchImpl) : null;
  const secure = auth?.publicBaseUrl.startsWith('https://') ?? false;
  const isAllowed = (email: string) => !!auth && auth.allowedEmails.includes(email.toLowerCase());
  const loginPage = (q: string) => `${(auth?.appUrl ?? '/').replace(/\/$/, '')}/login?${q}`;

  function authenticate(req: { headers: { cookie?: string } }): { user: SessionClaims } | AuthFailure {
    if (!auth) return { status: 503, code: 'auth_not_configured' };
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return { status: 401, code: 'unauthenticated' };
    const v = verify<SessionClaims>(token, sessionSecret, 'session');
    if (!v.ok) return { status: 401, code: v.reason === 'expired' ? 'session_expired' : 'unauthenticated' };
    if (!isAllowed(v.value.email)) return { status: 403, code: 'account_not_allowed' };
    return { user: v.value };
  }

  const fail = (reply: FastifyReply, f: AuthFailure) =>
    reply.code(f.status).header('cache-control', 'no-store').send({ error: f.code });

  const setSession = (reply: FastifyReply, claims: Omit<SessionClaims, 'iat' | 'exp'>) => {
    const iat = Math.floor(Date.now() / 1000);
    const ttl = auth!.sessionTtlSeconds;
    const token = sign({ ...claims, iat, exp: iat + ttl } satisfies SessionClaims, sessionSecret, 'session');
    reply.header('set-cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: ttl, path: '/', secure }));
  };

  const clearCookie = (name: string, p: string) => serializeCookie(name, '', { maxAge: 0, path: p, secure });

  // ---- 전역 보호: 기본 차단 + 공개 경로 허용목록 ----
  // 라우터는 퍼센트 인코딩(/%61pi/...)을 디코딩해 매칭하므로 raw URL 접두사 검사는 우회된다.
  // 따라서 디코딩한 경로가 공개 허용목록(/healthz, /auth/**)에 속할 때만 통과시키고 나머지는 모두 인증한다.
  const isPublicPath = (rawUrl: string) => {
    const raw = rawUrl.split(/[?#]/, 1)[0] ?? '';
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return false;
    }
    // 원문과 디코딩 결과 모두 공개 경로여야 한다(둘이 다르면 어느 쪽으로 라우팅되든 안전하도록).
    const pub = (p: string) => p === '/healthz' || p === '/auth' || p.startsWith('/auth/');
    return pub(raw) && pub(decoded);
  };
  app.addHook('onRequest', async (req, reply) => {
    if (isPublicPath(req.url)) return;
    const r = authenticate(req);
    if ('status' in r) return fail(reply, r);
    (req as FastifyRequest & { user?: SessionClaims }).user = r.user;
  });

  // ---- 로그인 / 로그아웃 / 세션 ----
  app.get('/auth/login', async (_req, reply) => {
    if (!auth || !oidc) return reply.code(503).send({ error: 'auth_not_configured' });
    const flow: Flow = { kind: 'login', state: b64url(), nonce: b64url(), verifier: b64url(48), exp: Math.floor(Date.now() / 1000) + FLOW_TTL_S };
    // 로그인 scope 는 openid email profile 만 요청한다. Drive scope 는 /auth/drive/connect 에서 별도 동의로 요청.
    const url = await oidc.authorizationUrl({ scope: LOGIN_SCOPE, redirectUri: oidc.redirectUri, state: flow.state, nonce: flow.nonce, challenge: challengeOf(flow.verifier), extra: { prompt: 'select_account' } });
    reply.header('set-cookie', serializeCookie(FLOW_COOKIE, sign(flow, sessionSecret, 'flow'), { maxAge: FLOW_TTL_S, path: '/auth', secure }));
    return reply.redirect(url);
  });

  app.get('/auth/callback', async (req, reply) => {
    if (!auth || !oidc) return reply.code(503).send({ error: 'auth_not_configured' });
    reply.header('set-cookie', clearCookie(FLOW_COOKIE, '/auth'));
    const q = req.query as Record<string, string | undefined>;
    const flow = verify<Flow>(parseCookies(req.headers.cookie)[FLOW_COOKIE], sessionSecret, 'flow');
    if (!flow.ok || flow.value.kind !== 'login' || !q.state || q.state !== flow.value.state) return reply.redirect(loginPage('error=login_failed'));
    if (q.error || !q.code) return reply.redirect(loginPage('error=login_failed'));
    try {
      const tok = await oidc.exchange(q.code, flow.value.verifier, oidc.redirectUri);
      if (!tok.id_token) throw new OidcError('no_id_token');
      const claims = await oidc.verifyIdToken(tok.id_token, flow.value.nonce);
      // 허용 계정 검사: 이메일이 Google 에서 검증되었고 허용 목록에 있어야 한다. 아니면 세션을 만들지 않는다.
      if (claims.email_verified !== true || !claims.email || !isAllowed(claims.email)) return reply.redirect(loginPage('error=not_allowed'));
      setSession(reply, { sub: claims.sub, email: claims.email.toLowerCase(), name: claims.name });
      return reply.redirect(auth.appUrl);
    } catch (e) {
      req.log.warn({ code: e instanceof OidcError ? e.code : 'unexpected' }, 'login failed');
      return reply.redirect(loginPage('error=login_failed'));
    }
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', clearCookie(SESSION_COOKIE, '/'));
    return reply.header('cache-control', 'no-store').send({ ok: true });
  });

  app.get('/auth/session', async (req, reply) => {
    const r = authenticate(req);
    if ('status' in r) return fail(reply, r);
    reply.header('cache-control', 'no-store');
    return { email: r.user.email, name: r.user.name ?? null, driveConnected: r.user.drive === true };
  });

  // ---- Drive 동의(로그인과 분리) ----
  app.get('/auth/drive/connect', async (req, reply) => {
    if (!auth || !oidc) return reply.code(503).send({ error: 'auth_not_configured' });
    const r = authenticate(req);
    if ('status' in r) return fail(reply, r);
    const flow: Flow = { kind: 'drive', state: b64url(), nonce: '', verifier: b64url(48), sub: r.user.sub, exp: Math.floor(Date.now() / 1000) + FLOW_TTL_S };
    const url = await oidc.authorizationUrl({ scope: DRIVE_SCOPE, redirectUri: oidc.driveRedirectUri, state: flow.state, challenge: challengeOf(flow.verifier), extra: { login_hint: r.user.email, access_type: 'offline', prompt: 'consent' } });
    reply.header('set-cookie', serializeCookie(FLOW_COOKIE, sign(flow, sessionSecret, 'flow'), { maxAge: FLOW_TTL_S, path: '/auth', secure }));
    return reply.redirect(url);
  });

  app.get('/auth/drive/callback', async (req, reply) => {
    if (!auth || !oidc) return reply.code(503).send({ error: 'auth_not_configured' });
    reply.header('set-cookie', clearCookie(FLOW_COOKIE, '/auth'));
    const r = authenticate(req);
    if ('status' in r) return reply.redirect(loginPage(`reason=${r.code === 'session_expired' ? 'expired' : 'signin'}`));
    const q = req.query as Record<string, string | undefined>;
    const flow = verify<Flow>(parseCookies(req.headers.cookie)[FLOW_COOKIE], sessionSecret, 'flow');
    const back = auth.appUrl.replace(/\/$/, '') + '/';
    // 동의 거부 등은 로그인 상태를 유지한 채 Drive 미연결로 돌아간다.
    if (!flow.ok || flow.value.kind !== 'drive' || flow.value.sub !== r.user.sub || !q.state || q.state !== flow.value.state) return reply.redirect(`${back}?drive=failed`);
    if (q.error || !q.code) return reply.redirect(`${back}?drive=denied`);
    try {
      const tok = await oidc.exchange(q.code, flow.value.verifier, oidc.driveRedirectUri);
      if (!(tok.scope ?? '').split(' ').includes(DRIVE_SCOPE)) return reply.redirect(`${back}?drive=denied`);
      // Drive 토큰의 보관·사용은 후속 Task(Drive 연동). 여기서는 동의 완료 상태만 세션에 기록한다.
      setSession(reply, { sub: r.user.sub, email: r.user.email, name: r.user.name, drive: true });
      return reply.redirect(`${back}?drive=connected`);
    } catch {
      return reply.redirect(`${back}?drive=failed`);
    }
  });

  // ---- 보호 자원 (위 onRequest 훅이 먼저 인증한다) ----
  app.get('/api/entries', async (_req, reply) => reply.header('cache-control', 'private, no-store').send({ entries: await opts.entries.list() }));

  for (const [route, dir] of [['attachments', 'attachments'], ['videos', 'videos']] as const) {
    app.get(`/api/${route}/:name`, async (req, reply) => {
      const name = (req.params as { name: string }).name;
      // 파일명 한 단계만 허용: 경로 구분자·상위 이동·숨김 파일 차단
      if (!/^[\w][\w.-]*$/.test(name) || name.includes('..')) return reply.code(400).send({ error: 'invalid_name' });
      const full = path.join(opts.fileStorageDir, dir, name);
      const st = await stat(full).catch(() => null);
      if (!st?.isFile()) return reply.code(404).send({ error: 'not_found' });
      const type = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' }[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
      reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').type(type).header('content-length', st.size);
      return reply.send(createReadStream(full));
    });
  }
  return { authenticate };
}
