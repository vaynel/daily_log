import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
  accessToken: string;
  stateFile: string;
  /** 구독 endpoint로 허용하는 push 서비스 호스트(https 전용). */
  allowedHosts: string[];
  /** 로컬 합성 push 서비스용 host:port. loopback 바인딩에서만 허용. */
  insecureHosts: string[];
  staticDir: string | null;
}

export const DEFAULT_PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const b64urlBytes = (v: string): number => Buffer.from(v, 'base64url').length;

function readSecretFile(path: string | undefined, name: string, problems: string[]): string {
  if (!path?.trim()) {
    problems.push(`${name} 누락: 비밀값 파일 경로`);
    return '';
  }
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error('not a file');
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      problems.push(`${name} 파일 권한이 너무 넓음 (0600 필요)`);
      return '';
    }
    return readFileSync(path, 'utf8').trim();
  } catch {
    problems.push(`${name} 파일을 읽을 수 없음`);
    return '';
  }
}

/**
 * PUSH_ENABLED=1 일 때만 활성화. 활성화했는데 설정이 하나라도 빠지면 값 없이 키 이름만 담아 던진다(fail closed).
 * 비밀값(VAPID 개인키, 접근 토큰)은 환경변수가 아니라 0600 파일에서만 읽는다.
 */
export function loadPushConfig(
  env: NodeJS.ProcessEnv,
  fileStorageDir: string,
  host: string,
): { config: PushConfig | null; problems: string[] } {
  if (env.PUSH_ENABLED !== '1') return { config: null, problems: [] };
  const problems: string[] = [];

  const publicKey = env.PUSH_VAPID_PUBLIC_KEY?.trim() ?? '';
  if (!publicKey) problems.push('PUSH_VAPID_PUBLIC_KEY 누락');
  else if (b64urlBytes(publicKey) !== 65) problems.push('PUSH_VAPID_PUBLIC_KEY 형식 오류 (base64url 65바이트)');
  const privateKey = readSecretFile(env.PUSH_VAPID_PRIVATE_KEY_FILE, 'PUSH_VAPID_PRIVATE_KEY_FILE', problems);
  if (privateKey && b64urlBytes(privateKey) !== 32) problems.push('VAPID 개인키 파일 형식 오류 (base64url 32바이트)');
  const subject = env.PUSH_VAPID_SUBJECT?.trim() ?? '';
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) problems.push('PUSH_VAPID_SUBJECT 누락 또는 형식 오류 (mailto: 또는 https://)');
  const accessToken = readSecretFile(env.PUSH_ACCESS_TOKEN_FILE, 'PUSH_ACCESS_TOKEN_FILE', problems);
  if (accessToken && accessToken.length < 32) problems.push('접근 토큰이 너무 짧음 (32자 이상)');

  if (!LOOPBACK.has(host) && env.PUSH_ALLOW_NON_LOOPBACK !== '1') {
    problems.push('HOST가 loopback이 아님: TLS 프록시 뒤에서만 PUSH_ALLOW_NON_LOOPBACK=1 로 허용');
  }
  const insecureHosts = (env.PUSH_DEV_INSECURE_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (insecureHosts.length && !LOOPBACK.has(host)) problems.push('PUSH_DEV_INSECURE_HOSTS 는 loopback 바인딩에서만 허용');

  const allowedHosts = env.PUSH_ALLOWED_HOSTS?.trim()
    ? env.PUSH_ALLOWED_HOSTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_PUSH_HOSTS;

  if (problems.length) return { config: null, problems };
  return {
    problems,
    config: {
      publicKey,
      privateKey,
      subject,
      accessToken,
      stateFile: env.PUSH_STATE_FILE?.trim() || join(fileStorageDir, 'push-state.json'),
      allowedHosts,
      insecureHosts,
      staticDir: env.PUSH_STATIC_DIR?.trim() || null,
    },
  };
}
