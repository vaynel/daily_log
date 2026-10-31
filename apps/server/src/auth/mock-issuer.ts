// 시험 전용 모의 OIDC 발급자: Google 과 같은 authorization code + PKCE(S256), nonce, RS256 id_token.
import { createHash, createSign, generateKeyPairSync, randomUUID, type JsonWebKey } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockAccount {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
}

export interface Tamper {
  aud?: string;
  nonce?: string;
  expOffsetSeconds?: number;
  signWithOtherKey?: boolean;
  iss?: string;
  alg?: string;
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

export async function startMockIssuer(opts: { clientId: string; clientSecret: string }) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(key.publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { challenge: string; nonce?: string; scope: string; redirectUri: string; account: MockAccount }>();
  const state = {
    account: { sub: 'sub-owner', email: 'owner@example.test', email_verified: true, name: 'Owner' } as MockAccount,
    tamper: {} as Tamper,
    /** Drive 동의 거부 시뮬레이션 */
    denyDrive: false,
    authorizeRequests: [] as URLSearchParams[],
    tokenRequests: 0,
    /** Drive 갱신 토큰 시뮬레이션: 발급된 토큰, 철회된 토큰, 갱신 요청 수, 갱신 시 서버 오류 */
    refreshTokens: new Set<string>(),
    revoked: new Set<string>(),
    refreshRequests: 0,
    refreshServerError: false,
    /** 갱신 토큰을 응답에 넣지 않는다(재동의 없이 재연결하는 경우 시뮬레이션) */
    omitRefreshToken: false,
  };
  let issuer = '';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (o: object, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` });
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      state.authorizeRequests.push(q);
      if (q.get('client_id') !== opts.clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) {
        res.writeHead(400);
        return res.end('bad authorize request');
      }
      const redirect = new URL(q.get('redirect_uri') ?? '');
      redirect.searchParams.set('state', q.get('state')!);
      const scope = q.get('scope') ?? '';
      if (scope.includes('drive') && state.denyDrive) redirect.searchParams.set('error', 'access_denied');
      else {
        const code = randomUUID();
        codes.set(code, { challenge: q.get('code_challenge')!, nonce: q.get('nonce') ?? undefined, scope, redirectUri: redirect.origin + redirect.pathname, account: state.account });
        redirect.searchParams.set('code', code);
      }
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (url.pathname === '/revoke' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        state.revoked.add(new URLSearchParams(body).get('token') ?? '');
        json({});
      });
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        state.tokenRequests++;
        const f = new URLSearchParams(body);
        if (f.get('grant_type') === 'refresh_token') {
          state.refreshRequests++;
          if (state.refreshServerError) return json({ error: 'temporarily_unavailable' }, 503);
          const rt = f.get('refresh_token') ?? '';
          if (f.get('client_secret') !== opts.clientSecret || !state.refreshTokens.has(rt) || state.revoked.has(rt)) return json({ error: 'invalid_grant' }, 400);
          return json({ access_token: `mock-access-${randomUUID()}`, token_type: 'Bearer', expires_in: 3600 });
        }
        const entry = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? ''); // 코드는 1회용
        const okPkce = entry && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === entry.challenge;
        if (!entry || !okPkce || f.get('client_secret') !== opts.clientSecret || f.get('client_id') !== opts.clientId || f.get('redirect_uri') !== entry.redirectUri) {
          return json({ error: 'invalid_grant' }, 400);
        }
        const out: Record<string, string> = { access_token: 'mock-access', token_type: 'Bearer', scope: entry.scope };
        if (entry.scope.includes('drive') && !state.omitRefreshToken) {
          out.refresh_token = `mock-refresh-${randomUUID()}`;
          state.refreshTokens.add(out.refresh_token);
        }
        if (entry.scope.split(' ').includes('openid')) {
          const t = state.tamper;
          const header = { alg: t.alg ?? 'RS256', kid: 'k1', typ: 'JWT' };
          const now = Math.floor(Date.now() / 1000);
          const payload = {
            iss: t.iss ?? issuer,
            aud: t.aud ?? opts.clientId,
            sub: entry.account.sub,
            iat: now,
            exp: now + (t.expOffsetSeconds ?? 3600),
            nonce: t.nonce ?? entry.nonce,
            email: entry.account.email,
            email_verified: entry.account.email_verified ?? true,
            name: entry.account.name,
          };
          const signing = `${b64(header)}.${b64(payload)}`;
          const sig = createSign('RSA-SHA256').update(signing).sign((t.signWithOtherKey ? other : key).privateKey).toString('base64url');
          out.id_token = `${signing}.${sig}`;
        }
        json(out);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}
