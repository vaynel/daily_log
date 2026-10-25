export interface Config {
  databaseUrl: string;
  fileStorageDir: string;
  sessionSecret: string;
  port: number;
  host: string;
  workerPollIntervalMs: number;
  /** VAPID 키 JSON 파일 경로(서버 파일에서만 읽음). 없으면 푸시 발송 비활성. */
  vapidKeysFile: string | null;
}

const REQUIRED = {
  DATABASE_URL: '데이터베이스 연결 문자열',
  FILE_STORAGE_DIR: '비공개 파일 저장 디렉터리',
  SESSION_SECRET: '세션 서명 비밀값 (16자 이상)',
} as const;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`설정 오류:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** 값 자체는 오류 메시지에 포함하지 않는다(키 이름과 사유만). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  for (const [key, desc] of Object.entries(REQUIRED)) {
    if (!env[key]?.trim()) problems.push(`${key} 누락: ${desc}`);
  }
  const secret = env.SESSION_SECRET?.trim();
  if (secret && secret.length < 16) problems.push('SESSION_SECRET 값이 너무 짧음 (16자 이상)');

  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT 값이 올바르지 않음 (1-65535)');
  const poll = Number(env.WORKER_POLL_INTERVAL_MS ?? '2000');
  if (!Number.isInteger(poll) || poll < 100) problems.push('WORKER_POLL_INTERVAL_MS 값이 올바르지 않음 (100 이상 정수)');

  if (problems.length) throw new ConfigError(problems);
  return {
    databaseUrl: env.DATABASE_URL!.trim(),
    fileStorageDir: env.FILE_STORAGE_DIR!.trim(),
    sessionSecret: secret!,
    port,
    host: env.HOST?.trim() || '127.0.0.1',
    workerPollIntervalMs: poll,
    vapidKeysFile: env.VAPID_KEYS_FILE?.trim() || null,
  };
}

/** 설정 실패 시 누락 항목을 stderr에 표시하고 안전하게 종료(코드 78). */
export function loadConfigOrExit(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      console.error('.env.example 을 참고해 .env 를 설정하세요.');
      process.exit(78);
    }
    throw e;
  }
}
