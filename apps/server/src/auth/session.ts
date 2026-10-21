import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionClaims {
  sub: string;
  email: string;
  name?: string;
  /** Drive 동의 완료 여부(로그인과 별개) */
  drive?: boolean;
  iat: number;
  exp: number;
}

/** HMAC-SHA256 서명 토큰: base64url(payload).base64url(sig). 용도(purpose)가 서명에 포함되어 쿠키 간 재사용이 안 된다. */
export function sign(payload: object, secret: string, purpose: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body, secret, purpose)}`;
}

export type Verified<T> = { ok: true; value: T } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verify<T extends { exp: number }>(token: string | undefined, secret: string, purpose: string, now = Date.now()): Verified<T> {
  const parts = token?.split('.') ?? [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(mac(parts[0], secret, purpose));
  const given = Buffer.from(parts[1]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
  let value: T;
  try {
    value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as T;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof value?.exp !== 'number') return { ok: false, reason: 'malformed' };
  if (value.exp * 1000 <= now) return { ok: false, reason: 'expired' };
  return { ok: true, value };
}

function mac(body: string, secret: string, purpose: string): string {
  return createHmac('sha256', secret).update(`${purpose}\n${body}`).digest('base64url');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function serializeCookie(name: string, value: string, opts: { maxAge: number; path: string; secure: boolean }): string {
  return `${name}=${value}; Path=${opts.path}; Max-Age=${opts.maxAge}; HttpOnly; SameSite=Lax${opts.secure ? '; Secure' : ''}`;
}
