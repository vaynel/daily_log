import { readFileSync, statSync } from 'node:fs';

export type KeyProblem = 'ENV_MISSING' | 'FILE_MISSING' | 'NOT_REGULAR_FILE' | 'MODE_NOT_0600' | 'EMPTY';

export class VoiceConfigError extends Error {
  /** 값이 아니라 환경변수 이름과 사유 코드만 담는다. */
  constructor(public readonly problems: { env: string; code: KeyProblem }[]) {
    super(`음성 시험 설정 오류:\n${problems.map((p) => `  - ${p.env}: ${p.code}`).join('\n')}`);
    this.name = 'VoiceConfigError';
  }
}

/** 키 파일은 일반 파일이며 권한이 정확히 0600이고 비어 있지 않아야 한다. 경로·키 값은 오류에 넣지 않는다. */
export function readKeyFile(env: string, path: string | undefined): { key: string } | { problem: KeyProblem } {
  if (!path?.trim()) return { problem: 'ENV_MISSING' };
  let st;
  try {
    st = statSync(path.trim());
  } catch {
    return { problem: 'FILE_MISSING' };
  }
  if (!st.isFile()) return { problem: 'NOT_REGULAR_FILE' };
  if ((st.mode & 0o777) !== 0o600) return { problem: 'MODE_NOT_0600' };
  let key: string;
  try {
    key = readFileSync(path.trim(), 'utf8').trim();
  } catch {
    return { problem: 'FILE_MISSING' };
  }
  if (!key) return { problem: 'EMPTY' };
  void env;
  return { key };
}

export interface VoiceKeys { openai: string; gemini: string }

/** 하나라도 문제가 있으면 예외(fail closed). 시작 전에 호출한다. */
export function loadVoiceKeys(env: NodeJS.ProcessEnv = process.env): VoiceKeys {
  const problems: { env: string; code: KeyProblem }[] = [];
  const out: Partial<VoiceKeys> = {};
  for (const [field, name] of [['openai', 'DAILY_LOG_OPENAI_KEY_FILE'], ['gemini', 'DAILY_LOG_GEMINI_KEY_FILE']] as const) {
    const r = readKeyFile(name, env[name]);
    if ('problem' in r) problems.push({ env: name, code: r.problem });
    else out[field] = r.key;
  }
  if (problems.length) throw new VoiceConfigError(problems);
  return out as VoiceKeys;
}
