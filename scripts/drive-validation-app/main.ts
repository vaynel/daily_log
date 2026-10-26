import { fstatSync } from 'node:fs';
import { readiness, type ProtectedSettings } from './config.js';
import { startValidationApp } from './app.js';

async function protectedInput(): Promise<ProtectedSettings> {
  const st = fstatSync(0);
  if (!st.isFIFO() && !st.isSocket()) return {};
  return new Promise((resolve) => {
    let input = '';
    const finish = (value: ProtectedSettings) => { clearTimeout(timer); process.stdin.pause(); resolve(value); };
    const timer = setTimeout(() => finish({}), 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
      if (input.length > 16384) finish({});
    });
    process.stdin.on('end', () => {
      try {
        const value: unknown = JSON.parse(input);
        finish(value && typeof value === 'object' && !Array.isArray(value) ? value as ProtectedSettings : {});
      } catch { finish({}); }
    });
    process.stdin.on('error', () => finish({}));
  });
}
async function main() {
  const args = process.argv.slice(2);
  const mode = args.length === 1 ? args[0] : undefined;
  const settings = mode === '--real' ? await protectedInput() : {};
  const check = readiness(mode, process.env.DATABASE_URL, settings);
  if (check.result !== 'CONFIG_READY') {
    console.log(JSON.stringify(check)); process.exitCode = 2; return;
  }
  const runtime = await startValidationApp({ mode: mode as '--fake' | '--real', databaseUrl: process.env.DATABASE_URL!, settings });
  console.log(JSON.stringify({ result: 'LISTENING', mode: mode!.slice(2), browserUrl: `${runtime.base}/auth/login`,
    callbackUris: [`${runtime.base}/auth/callback`, `${runtime.base}/auth/drive/callback`],
    schema: runtime.schema, actualGoogleDrive: 'NOT_RUN', actualAndroid: 'NOT_RUN', deployment: 'NOT_RUN' }));
  let closing = false;
  const stop = async () => { if (!closing) { closing = true; await runtime.close(); } };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}
main().catch(() => { console.log(JSON.stringify({ result: 'FAIL', stage: 'startup', actualGoogleDrive: 'NOT_RUN' })); process.exitCode = 1; });
