import Fastify from 'fastify';
import { registerAuth, type EntryStore } from './auth/plugin.js';
import type { AuthConfig } from './auth/config.js';
import { AttachmentService } from './attachments/service.js';
import { registerRecordRoutes } from './attachments/routes.js';
import { registerRecordViewRoutes } from './records/routes.js';
import type { RecordStore } from './records/store.js';
import { registerTrashRoutes } from './records/trash-routes.js';
import type { RetentionService } from './retention/service.js';
import { registerInterview } from './interview/routes.js';
import type { ExclusionRuleStore } from './briefing/rules.js';
import { registerRevisionRoutes } from './records/revision.js';
import { registerBriefing } from './briefing/routes.js';
import type { ProInfer } from './briefing/briefing.js';
import type { LiveUsageStore } from './interview/usage.js';
import type { LiveConfig } from './voice/live.js';
import type { MonthlyLedger } from './budget/ledger.js';
import type { DriveConnectionStore } from './backup/connections.js';
import type { BackupService } from './backup/service.js';
import { registerBackupRoutes } from './backup/routes.js';
import { registerNotifyRoutes } from './notify/routes.js';
import type { NotificationService } from './notify/service.js';

export interface AppOptions {
  auth?: AuthConfig | null;
  sessionSecret?: string;
  fileStorageDir?: string;
  entries?: EntryStore;
  fetchImpl?: typeof fetch;
  drive?: DriveConnectionStore;
  backup?: BackupService;
  records?: RecordStore;
  /** 영구 삭제(파일 포함). 없으면 영구 삭제 명령은 501 이고 휴지통·복구는 그대로 동작한다. */
  retention?: RetentionService;
  now?: () => Date;
  /** 제품 음성 인터뷰(Gemini Live). usage 와 records 가 있으면 라우트를 등록하고, live 가 null 이면 대화 시작은 fail closed. */
  interview?: { usage: LiveUsageStore; live: LiveConfig | null; monthly?: MonthlyLedger; sessionDir: string; liveNow?: () => number };
  /** 통합 브리핑. infer 가 null 이면 생성은 fail closed(Pro 정리 미설정). 유료 모델로 자동 전환하지 않는다. */
  briefing?: { infer: ProInfer | null; rules?: ExclusionRuleStore };
  notifications?: NotificationService;
  vapidPublicKey?: string | null;
}

export function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } });
  app.get('/healthz', async () => ({ status: 'ok' }));
  const { authenticate } = registerAuth(app, {
    auth: opts.auth ?? null,
    sessionSecret: opts.sessionSecret ?? '',
    fileStorageDir: opts.fileStorageDir ?? '',
    entries: opts.entries ?? { list: async () => [] },
    fetchImpl: opts.fetchImpl,
    drive: opts.drive,
  });
  if (opts.records) {
    registerRecordRoutes(app, { store: opts.records, attachments: new AttachmentService(opts.records, opts.fileStorageDir ?? ''), now: opts.now });
    registerRecordViewRoutes(app, { store: opts.records, fileStorageDir: opts.fileStorageDir ?? '', now: opts.now });
    registerTrashRoutes(app, { store: opts.records, retention: opts.retention, now: opts.now });
  }
  if (opts.records && opts.interview) {
    registerInterview(app, { records: opts.records, authenticate, now: opts.now, ...opts.interview });
  }
  if (opts.records && opts.interview && opts.briefing) {
    registerBriefing(app, { records: opts.records, usage: opts.interview.usage, infer: opts.briefing.infer, rules: opts.briefing.rules, now: opts.now });
    registerRevisionRoutes(app, { store: opts.records, rules: opts.briefing.rules, now: opts.now });
  }
  if (opts.backup) registerBackupRoutes(app, { service: opts.backup, now: opts.now });
  if (opts.notifications) registerNotifyRoutes(app, { service: opts.notifications, vapidPublicKey: opts.vapidPublicKey });
  return app;
}
