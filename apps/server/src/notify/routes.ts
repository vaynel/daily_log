import type { FastifyInstance } from 'fastify';
import type { SessionClaims } from '../auth/session.js';
import { isValidTime } from './schedule.js';
import { PERMISSIONS, type NotificationService, type Permission } from './service.js';

/** 전달 실패 안내. 문구는 기록·제작 상태와 무관함을 분명히 한다. */
export const GUIDANCE: Record<string, string> = {
  PERMISSION_DENIED: '알림 권한이 꺼져 있어 알림을 보내지 못했습니다. 기기 설정 > 앱 > 알림에서 켠 뒤 이 화면에서 권한을 다시 확인하세요. 기록과 영상은 그대로입니다.',
  NO_SUBSCRIPTION: '이 기기에 알림이 연결되어 있지 않습니다. 알림 허용 후 이 화면에서 다시 연결하세요. 기록과 영상은 그대로입니다.',
  DELIVERY_FAILED: '알림 서비스 오류로 알림을 보내지 못했습니다. 기록 목록에서 직접 확인할 수 있습니다. 기록과 영상은 그대로입니다.',
  PUSH_NOT_CONFIGURED: '서버에 알림 발송 설정이 없어 보내지 못했습니다. 관리자에게 문의하세요. 기록과 영상은 그대로입니다.',
};
const guidanceFor = (status: string, code: string | null) => (status === 'UNDELIVERABLE' || status === 'FAILED' ? GUIDANCE[code ?? ''] ?? GUIDANCE.DELIVERY_FAILED! : null);

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

export function registerNotifyRoutes(app: FastifyInstance, opts: { service: NotificationService; vapidPublicKey?: string | null }) {
  const owner = (req: object) => (req as { user?: SessionClaims }).user!.sub;
  const s = opts.service;
  const noStore = (reply: { header(k: string, v: string): unknown }) => reply.header('cache-control', 'private, no-store');

  app.get('/api/notifications/settings', async (req, reply) => {
    noStore(reply);
    return { ...(await s.getSettings(owner(req))), timezone: 'Asia/Seoul', pushAvailable: !!opts.vapidPublicKey, vapidPublicKey: opts.vapidPublicKey ?? null };
  });

  app.put('/api/notifications/settings', async (req, reply) => {
    const t = (req.body as { interviewTime?: unknown } | null)?.interviewTime;
    if (!isValidTime(t)) return reply.code(400).send({ error: 'INVALID_TIME', message: '시각은 HH:MM(24시간, 한국 시간) 형식이어야 합니다' });
    return { ...(await s.setInterviewTime(owner(req), t)), timezone: 'Asia/Seoul' };
  });

  app.put('/api/notifications/permission', async (req, reply) => {
    const p = (req.body as { permission?: unknown } | null)?.permission;
    if (typeof p !== 'string' || !PERMISSIONS.includes(p as Permission)) return reply.code(400).send({ error: 'INVALID_PERMISSION' });
    await s.reportPermission(owner(req), p as Permission);
    return s.getSettings(owner(req));
  });

  app.put('/api/notifications/subscription', async (req, reply) => {
    const b = (req.body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = str(b.endpoint, 2048);
    const p256dh = str(b.keys?.p256dh, 256);
    const auth = str(b.keys?.auth, 256);
    if (!endpoint || !p256dh || !auth || !/^https:\/\//.test(endpoint)) return reply.code(400).send({ error: 'INVALID_SUBSCRIPTION' });
    await s.saveSubscription(owner(req), { endpoint, p256dh, auth });
    return s.getSettings(owner(req));
  });

  app.delete('/api/notifications/subscription', async (req, reply) => {
    const endpoint = str((req.body as { endpoint?: unknown } | null)?.endpoint, 2048);
    if (!endpoint) return reply.code(400).send({ error: 'INVALID_SUBSCRIPTION' });
    await s.removeSubscription(owner(req), endpoint);
    return s.getSettings(owner(req));
  });

  /** 최근 알림과 전달 실패 안내. 전달 상태는 기록·제작 상태와 별개다. */
  app.get('/api/notifications/status', async (req, reply) => {
    noStore(reply);
    const recent = await s.recent(owner(req));
    return { settings: await s.getSettings(owner(req)), recent: recent.map((n) => ({ ...n, guidance: guidanceFor(n.status, n.errorCode) })) };
  });
}
