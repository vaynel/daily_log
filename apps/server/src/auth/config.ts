export interface AuthConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** 외부에서 보이는 서버 주소. 콜백 URL 계산과 Secure 쿠키 판단에 사용 */
  publicBaseUrl: string;
  /** 소문자로 정규화된 허용 이메일 */
  allowedEmails: string[];
  sessionTtlSeconds: number;
  /** 로그인 후 이동할 웹 주소(상대 경로 가능) */
  appUrl: string;
}

export const LOGIN_SCOPE = 'openid email profile';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * 인증 설정은 선택 사항이다: 하나라도 없으면 null 을 돌려주고, 이때 보호된 경로는 전부 차단(fail closed)된다.
 * 값 자체는 어디에도 출력하지 않는다.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const allowed = (env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!clientId || !clientSecret || allowed.length === 0) return null;
  const ttl = Number(env.SESSION_TTL_SECONDS ?? '43200');
  return {
    issuer: env.GOOGLE_ISSUER?.trim() || 'https://accounts.google.com',
    clientId,
    clientSecret,
    publicBaseUrl: (env.PUBLIC_BASE_URL?.trim() || `http://127.0.0.1:${env.PORT ?? '3000'}`).replace(/\/$/, ''),
    allowedEmails: allowed,
    sessionTtlSeconds: Number.isInteger(ttl) && ttl >= 1 ? ttl : 43200,
    appUrl: env.APP_URL?.trim() || '/',
  };
}
