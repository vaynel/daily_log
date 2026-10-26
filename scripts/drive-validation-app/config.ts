/** This entrypoint reads no production env files. Only the injected test DB and
 * a dedicated, anonymous stdin pipe for real OAuth settings are accepted. */
export interface ProtectedSettings {
  enableReal?: boolean;
  clientId?: string;
  clientSecret?: string;
  allowedEmail?: string;
  sessionSecret?: string;
  tokenKey?: string;
  publicBaseUrl?: string;
  approvedLoopbackAccess?: boolean;
}
export function testDatabaseAllowed(value: string | undefined): boolean {
  try {
    const u = new URL(value!);
    return ['postgres:', 'postgresql:'].includes(u.protocol)
      && u.hostname === 'daily-log-test-postgres17' && u.port === '5432'
      && u.pathname === '/daily_log_backend_test' && !u.search && !u.hash
      && !!u.username && !!u.password;
  } catch { return false; }
}
export function readiness(mode: string | undefined, database: string | undefined, s: ProtectedSettings = {}) {
  const missing: string[] = [];
  if (!testDatabaseAllowed(database)) missing.push('TEST_DATABASE_URL');
  if (mode !== '--fake') {
    if (mode !== '--real' || s.enableReal !== true) missing.push('EXPLICIT_REAL_ENABLE');
    for (const [key, name] of [['clientId', 'OAUTH_CLIENT_ID'], ['clientSecret', 'OAUTH_CLIENT_SECRET'], ['allowedEmail', 'ALLOWED_EMAIL'], ['sessionSecret', 'SESSION_SECRET'], ['tokenKey', 'TOKEN_KEY'], ['publicBaseUrl', 'OAUTH_REDIRECT_BASE']] as const) {
      if (typeof s[key] !== 'string' || !s[key]?.trim()) missing.push(name);
    }
    if (s.sessionSecret && s.sessionSecret.length < 32) missing.push('SESSION_SECRET_LENGTH');
    if (s.tokenKey && s.tokenKey.length < 32) missing.push('TOKEN_KEY_LENGTH');
    if (s.allowedEmail && !/^[^\s,@]+@[^\s,@]+$/.test(s.allowedEmail)) missing.push('SINGLE_OWNER_EMAIL');
    if (s.publicBaseUrl && s.publicBaseUrl !== 'http://127.0.0.1:3000') missing.push('LOOPBACK_REDIRECT_BASE');
    if (s.approvedLoopbackAccess !== true) missing.push('APPROVED_BROWSER_LOOPBACK_ACCESS');
  }
  return { result: missing.length ? 'NOT_READY' : 'CONFIG_READY', missing, actualGoogleDrive: 'NOT_RUN', actualAndroid: 'NOT_RUN', deployment: 'NOT_RUN' };
}

/** Every OAuth/Drive request (including discovered endpoints/upload Locations)
 * passes this gate. Redirects are never followed, and failures never expose URL. */
export function guardedFetch(origins: ReadonlySet<string>, underlying: typeof fetch = fetch) {
  const counts = { allowed: 0, blocked: 0, external: 0 };
  const request: typeof fetch = async (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!origins.has(u.origin) || u.username || u.password || !['GET', 'POST', 'PUT'].includes(method)) {
      counts.blocked++;
      throw new Error('NETWORK_TARGET_BLOCKED');
    }
    counts.allowed++;
    if (u.hostname !== '127.0.0.1') counts.external++;
    return underlying(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  };
  return { request, counts };
}
