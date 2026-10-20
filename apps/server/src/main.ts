import { buildApp } from './app.js';
import { loadConfigOrExit } from './config.js';
import { loadPushConfig } from './push/config.js';
import { PushService } from './push/service.js';
import { PushStore } from './push/store.js';

const config = loadConfigOrExit();
const { config: pushCfg, problems } = loadPushConfig(process.env, config.fileStorageDir, config.host);
if (problems.length) {
  console.error(`푸시 설정 오류:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(78);
}
let push = null;
if (pushCfg) {
  const store = new PushStore(pushCfg.stateFile);
  await store.load();
  push = { service: new PushService(pushCfg, store), accessToken: pushCfg.accessToken, staticDir: pushCfg.staticDir };
}
const app = buildApp({ push });
await app.listen({ port: config.port, host: config.host });
