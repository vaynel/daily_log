import { createHash, createPublicKey, createVerify, randomBytes, type JsonWebKey } from 'node:crypto';
import type { AuthConfig } from './config.js';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

export interface TokenResponse {
  id_token?: string;
  scope?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface IdClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export class OidcError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const b64url = (n = 32) => randomBytes(n).toString('base64url');
export const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export class OidcClient {
  private discovery?: Promise<Discovery>;

  constructor(private readonly cfg: AuthConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  get redirectUri() {
    return `${this.cfg.publicBaseUrl}/auth/callback`;
  }

  get driveRedirectUri() {
    return `${this.cfg.publicBaseUrl}/auth/drive/callback`;
  }

  private async meta(): Promise<Discovery> {
    this.discovery ??= this.fetchImpl(`${this.cfg.issuer}/.well-known/openid-configuration`).then(async (r) => {
      if (!r.ok) throw new OidcError('discovery_failed');
      return (await r.json()) as Discovery;
    });
    try {
      return await this.discovery;
    } catch (e) {
      this.discovery = undefined;
      throw e instanceof OidcError ? e : new OidcError('discovery_failed');
    }
  }

  async authorizationUrl(p: { scope: string; redirectUri: string; state: string; nonce?: string; challenge: string; extra?: Record<string, string> }) {
    const m = await this.meta();
    const u = new URL(m.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: p.redirectUri,
      scope: p.scope,
      state: p.state,
      code_challenge: p.challenge,
      code_challenge_method: 'S256',
      ...(p.nonce ? { nonce: p.nonce } : {}),
      ...p.extra,
    }).toString();
    return u.toString();
  }

  /** authorization code 교환. 응답의 scope/id_token 은 호출자가 검증한다. */
  async exchange(code: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
    const m = await this.meta();
    const res = await this.fetchImpl(m.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) throw new OidcError('token_exchange_failed');
    return (await res.json()) as TokenResponse;
  }

  /**
   * 갱신 토큰으로 접근 토큰을 새로 받는다. 거절(invalid_grant: 철회·만료)은 'invalid_grant', 네트워크·서버 오류는 'refresh_transient' 로 구분한다.
   */
  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const m = await this.meta();
    let res: Response;
    try {
      res = await this.fetchImpl(m.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
      });
    } catch {
      throw new OidcError('refresh_transient');
    }
    if (res.status === 400 || res.status === 401) throw new OidcError('invalid_grant');
    if (!res.ok) throw new OidcError('refresh_transient');
    const j = (await res.json().catch(() => null)) as TokenResponse | null;
    if (!j?.access_token) throw new OidcError('refresh_transient');
    return { accessToken: j.access_token, expiresInSeconds: typeof j.expires_in === 'number' ? j.expires_in : 3600 };
  }

  /** 연결 해제 시 Google 쪽 토큰 철회(최선 노력). 실패해도 서버의 토큰 삭제는 진행한다. */
  async revoke(token: string): Promise<boolean> {
    try {
      const m = await this.meta();
      if (!m.revocation_endpoint) return false;
      const res = await this.fetchImpl(m.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 서명(RS256, JWKS)·iss·aud·exp·nonce 를 검증한다. email_verified 는 호출자(allowlist 단계)에서 확인한다. */
  async verifyIdToken(idToken: string, nonce: string, now = Date.now()): Promise<IdClaims> {
    const [h, p, sig] = idToken.split('.');
    if (!h || !p || !sig || idToken.split('.').length !== 3) throw new OidcError('id_token_malformed');
    let header: { alg?: string; kid?: string };
    let claims: IdClaims;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      throw new OidcError('id_token_malformed');
    }
    if (header.alg !== 'RS256') throw new OidcError('id_token_bad_alg');
    const m = await this.meta();
    const jwksRes = await this.fetchImpl(m.jwks_uri);
    if (!jwksRes.ok) throw new OidcError('jwks_failed');
    const jwks = (await jwksRes.json()) as { keys: (JsonWebKey & { kid?: string })[] };
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new OidcError('id_token_unknown_key');
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
    if (!ok) throw new OidcError('id_token_bad_signature');
    if (claims.iss !== this.cfg.issuer && !(this.cfg.issuer === 'https://accounts.google.com' && claims.iss === 'accounts.google.com')) throw new OidcError('id_token_bad_iss');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.cfg.clientId)) throw new OidcError('id_token_bad_aud');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw new OidcError('id_token_expired');
    if (!claims.sub || claims.nonce !== nonce) throw new OidcError('id_token_bad_nonce');
    return claims;
  }
}
