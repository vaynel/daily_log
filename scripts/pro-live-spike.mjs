// Explicit, bounded development-session experiment; never a product adapter.
// Run only with authorization to use this session's existing ChatGPT login.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== '--run') throw new Error('Explicit --run required');
const [executable = 'codex', ...prefix] = process.argv.slice(3);
const env = { ...process.env };
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
const options = { env, encoding: 'utf8', timeout: 55000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
const auth = spawnSync(executable, [...prefix, 'login', 'status'], options);
const authText = (auth.stdout ?? '') + (auth.stderr ?? '');
const chatgptLoginObserved = auth.status === 0 && /Logged in using ChatGPT/i.test(authText) && !/API key/i.test(authText);
const cases = [
  { name: 'text-question', prompt: '합성 기록: 오늘 책을 10분 읽었다. 책에 관한 한국어 질문 하나만 출력하세요.', matches: s => /책/.test(s) && /\?/.test(s) },
  { name: 'record-summary', prompt: '합성 기록: 오늘 책을 10분 읽었다. 읽은 시간(분)을 숫자만 출력하세요.', matches: s => s.trim() === '10' },
  { name: 'allowed-attachment', prompt: 'What is the dominant color of the attached image? Reply with one English color word only.', image: fileURLToPath(new URL('../docs/spikes/fixtures/red.png', import.meta.url)), matches: s => s.trim().toLowerCase().replace(/\.$/, '') === 'red' },
];
const rows = [];
let stopped = !chatgptLoginObserved;
for (const c of cases) {
  if (stopped) { rows.push({ name: c.name, result: 'NOT_RUN', reason: 'WAIT_AUTH_OR_PRIOR_FAILURE', invocations: 0 }); continue; }
  const args = [...prefix, 'exec', '--ephemeral', '--json', '--sandbox', 'read-only'];
  if (c.image) args.push('-i', c.image);
  // -- ends the variadic --image argument before the prompt.
  args.push('--', `Do not use tools, read files, browse, or change anything. This is a synthetic capability probe only. ${c.prompt}`);
  const r = spawnSync(executable, args, options);
  const events = (r.stdout ?? '').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
  const completed = events.some(e => e.type === 'turn.completed');
  const toolItems = events.filter(e => e.item && !['agent_message', 'reasoning'].includes(e.item.type)).length;
  const matched = c.matches(messages.at(-1)?.item.text ?? '');
  const result = r.status === 0 && completed && matched && toolItems === 0 ? 'PASS' : 'FAIL';
  rows.push({ name: c.name, result, invocations: 1, exitCode: r.status, signal: r.signal, errorCode: r.error?.code ?? null, completed, matched, toolItems, rawOutputRetained: false });
  stopped = result !== 'PASS'; // Never retry or fall back on limit/auth/unknown errors.
}
console.log(JSON.stringify({ observedAt: new Date().toISOString(), provenance: 'LIVE_DEVELOPMENT_SESSION', chatgptLoginObserved, productAuthVerified: false, modelOverride: false, paidFallbackImplemented: false, rawOutputRetained: false, cases: rows }, null, 2));
