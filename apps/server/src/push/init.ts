// 비밀값 생성기: VAPID 키쌍과 접근 토큰을 지정 디렉터리에 0600 파일로 만든다. 값은 출력하지 않는다.
// 사용: node dist/push/init.js <디렉터리>   (이미 파일이 있으면 덮어쓰지 않고 종료)
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import webpush from 'web-push';

const dir = process.argv[2];
if (!dir) {
  console.error('사용법: push/init.js <비밀값 디렉터리>');
  process.exit(64);
}
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
const files: Record<string, string> = {
  'vapid-private.key': privateKey,
  'vapid-public.key': publicKey,
  'access-token': randomBytes(32).toString('base64url'),
};
for (const [name, value] of Object.entries(files)) {
  try {
    await writeFile(join(dir, name), `${value}\n`, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      console.error(`${name} 이미 존재: 덮어쓰지 않음. 새로 만들려면 디렉터리를 비우세요.`);
      process.exit(73);
    }
    throw e;
  }
}
console.log(`생성 완료(값 미출력): ${Object.keys(files).join(', ')} → ${dir} (0600)`);
