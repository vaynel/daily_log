// 추적 파일에서 실제 비밀값으로 보이는 패턴을 검사한다 (.env.example 의 자리표시 값은 허용).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const patterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /xox[abp]-[A-Za-z0-9-]{10,}/,
  /postgres(?:ql)?:\/\/[^:\s/]+:(?!change-me|ci-only|p@|p\b)[^@\s]{6,}@/,
];
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
let bad = 0;
for (const f of files) {
  if (f === 'package-lock.json' || f === 'scripts/scan-secrets.mjs') continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  for (const p of patterns) if (p.test(text)) { console.error(`의심 비밀값 패턴: ${f} (${p})`); bad++; }
}
if (bad) process.exit(1);
console.log(`scan-secrets: ${files.length} files OK`);
