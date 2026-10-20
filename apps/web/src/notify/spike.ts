import {
  DeliveryLedger,
  completionKey,
  interviewKey,
  isConfirmedDelivered,
  livingDayOf,
  permissionGuidance,
  type DeliveryRecord,
  type DispatchContext,
  type Transport,
} from './policy';

// Synthetic VAPID public key generated for local tests only. No private key exists in this repo.
const SYNTHETIC_VAPID_PUBLIC_KEY = 'BN_x2SxKtmsJ66Kl4aV8xUhhTfcWq_uX0Br4b7R89_Y8wDTA_KwChrFH5zwbV52GeKCzb4CeqOl8FJf1zMQmXDs';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ledger = new DeliveryLedger();
let subscription: PushSubscription | null = null;
let subscribeError = '';

const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
const permission = (): NotificationPermission | 'unsupported' => (supported ? Notification.permission : 'unsupported');
const ctx = (): DispatchContext => ({ permission: permission(), hasSubscription: subscription !== null });

const mockTransport = (status: number): Transport => ({ mock: true, send: async () => ({ httpStatus: status }) });

function renderPermission(): void {
  const g = permissionGuidance(permission());
  const el = $('perm');
  el.className = `card ${g.tone}`;
  el.innerHTML = '';
  const h = document.createElement('strong');
  h.textContent = g.title;
  const ol = document.createElement('ol');
  g.steps.forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s;
    ol.append(li);
  });
  el.append(h, ol);
  if (subscribeError) {
    const p = document.createElement('p');
    p.textContent = `푸시 구독 실패: ${subscribeError} (전달 가능 상태 아님)`;
    el.append(p);
  }
  $('ask').toggleAttribute('disabled', permission() !== 'default');
  $('env').textContent = `환경: 알림 API ${supported ? '있음' : '없음'} · 권한 ${permission()} · 구독 ${subscription ? '있음' : '없음'}`;
}

function renderLog(): void {
  const body = $('log');
  body.innerHTML = '';
  ledger.all().forEach((r: DeliveryRecord) => {
    const tr = document.createElement('tr');
    for (const t of [r.key, r.detail ? `${r.status} (${r.detail})` : r.status, isConfirmedDelivered(r) ? '예' : '아니오']) {
      const td = document.createElement('td');
      td.textContent = t;
      tr.append(td);
    }
    body.append(tr);
  });
}

async function send(key: string, kind: DeliveryRecord['kind'], status: number): Promise<void> {
  await ledger.dispatch(key, kind, ctx(), mockTransport(status));
  renderLog();
}

const slot = () => ({ userId: 'local-test', livingDay: livingDayOf(new Date()) });

$('ask').addEventListener('click', async () => {
  if (supported) await Notification.requestPermission();
  renderPermission();
});
$('recheck').addEventListener('click', renderPermission);
$('sub').addEventListener('click', async () => {
  subscribeError = '';
  try {
    const reg = await navigator.serviceWorker.register('/sw-notify.js');
    await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(SYNTHETIC_VAPID_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (e) {
    subscribeError = e instanceof Error ? e.name : 'error';
  }
  renderPermission();
});
$('send-ok').addEventListener('click', () => send(interviewKey(slot()), 'interview', 201));
$('send-dup').addEventListener('click', () => send(interviewKey(slot()), 'interview', 201));
$('send-410').addEventListener('click', () => send(`${interviewKey(slot())}:expired-case`, 'interview', 410));
$('send-done').addEventListener('click', () => send(completionKey('local-test', 'job-1'), 'completion', 201));

if (supported) navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data?.type === 'displayed') {
    ledger.confirmDisplayed(e.data.key);
    renderLog();
  }
});

if (supported) {
  navigator.serviceWorker.getRegistration().then(async (reg) => {
    subscription = (await reg?.pushManager.getSubscription()) ?? null;
    renderPermission();
  });
}
renderPermission();
renderLog();
