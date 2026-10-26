import type { FastifyInstance } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import type { BackupService } from './service.js';

/** 사유별 안내. 서버 원본·영상 열람과 무관하게 백업만 막힌 상태임을 분명히 한다. */
export const BACKUP_GUIDANCE: Record<string, string> = {
  DRIVE_NOT_CONNECTED: 'Google Drive가 연결되어 있지 않아 백업되지 않았습니다. Drive를 연결하면 이어서 백업합니다. 기록과 영상은 그대로입니다.',
  DRIVE_AUTH_EXPIRED: 'Drive 인증이 만료되었거나 철회되어 백업되지 않았습니다. Drive를 다시 연결하세요. 기록과 영상은 그대로입니다.',
  DRIVE_PERMISSION_DENIED: 'Drive 권한이 부족해 백업되지 않았습니다. Drive를 다시 연결하며 권한을 허용하세요. 기록과 영상은 그대로입니다.',
  DRIVE_QUOTA_INSUFFICIENT: 'Drive 용량이 부족해 백업되지 않았습니다. 기존 백업은 지우지 않습니다. 용량을 확보한 뒤 다시 시도하세요. 기록과 영상은 그대로입니다.',
  COPY_FAILED: 'Drive로 복사하지 못했습니다. 기록과 영상은 그대로이며 다시 시도할 수 있습니다.',
  RETRYING: 'Drive 복사 중 일시 오류가 있어 자동으로 한 번 다시 시도합니다.',
  SOURCE_INCOMPLETE: '서버에서 일부 파일을 찾지 못해 백업이 완료되지 않았습니다.',
  SOURCE_FILE_MISSING: '서버에서 파일을 찾지 못해 백업이 완료되지 않았습니다.',
  SOURCE_CORRUPT: '서버 파일의 내용이 기록과 달라 백업하지 않았습니다.',
  VERIFY_MISMATCH: 'Drive에 올린 파일을 확인하지 못해 백업 완료로 표시하지 않았습니다.',
};

export function registerBackupRoutes(app: FastifyInstance, opts: { service: BackupService; now?: () => Date }) {
  const owner = (req: object) => (req as { user?: SessionClaims }).user!.sub;
  const noStore = (reply: { header(k: string, v: string): unknown }) => reply.header('cache-control', 'private, no-store');
  const uuid = /^[0-9a-f-]{36}$/i;

  app.get('/api/backup/status', async (req, reply) => {
    noStore(reply);
    const st = await opts.service.status(owner(req));
    return { ...st, records: st.records.map((r) => ({ ...r, guidance: r.reason ? BACKUP_GUIDANCE[r.reason] ?? null : null })) };
  });

  /** 서버 원본 정리 가능 여부. live=1 이면 Drive 에서 지금 다시 확인한다(정리 직전 확인용). 이 호출은 아무것도 삭제하지 않는다. */
  app.get('/api/backup/records/:id/readiness', async (req, reply) => {
    noStore(reply);
    const id = (req.params as { id: string }).id;
    if (!uuid.test(id)) return reply.code(400).send({ error: 'INVALID_ID' });
    const live = (req.query as { live?: string }).live === '1';
    const r = await opts.service.cleanupReadiness(owner(req), id, { live });
    if (!r.found) return reply.code(404).send({ error: 'NOT_FOUND' });
    const { found: _f, ...rest } = r;
    void _f;
    return { ...rest, guidance: rest.reason ? BACKUP_GUIDANCE[rest.reason] ?? null : null, serverDeleteIsNotPropagatedToDrive: true };
  });

  app.post('/api/backup/records/:id/run', async (req, reply) => {
    noStore(reply);
    const id = (req.params as { id: string }).id;
    if (!uuid.test(id)) return reply.code(400).send({ error: 'INVALID_ID' });
    const own = await opts.service.cleanupReadiness(owner(req), id, { live: false });
    if (!own.found) return reply.code(404).send({ error: 'NOT_FOUND' });
    const r = await opts.service.enqueueInterview(id);
    return reply.code(202).send({ queued: !!r?.job, alreadyBackedUp: !!r && !r.job });
  });

  app.post('/api/backup/records/:id/retry', async (req, reply) => {
    noStore(reply);
    const id = (req.params as { id: string }).id;
    const cmd = req.headers['idempotency-key'];
    if (!uuid.test(id)) return reply.code(400).send({ error: 'INVALID_ID' });
    if (typeof cmd !== 'string' || cmd.trim().length < 8 || cmd.length > 100) return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    const r = await opts.service.requestRetry(owner(req), id, `backup-retry:${owner(req)}:${cmd.trim()}`);
    if (r.ok) return reply.code(202).send({ accepted: true, duplicate: r.duplicate });
    return reply.code(r.code === 'NOT_FOUND' ? 404 : 409).send({ error: r.code });
  });
}
