// Android 알림 실기기 시험 화면(TASK-51). 서버 /api/push/* 와 토큰 인증으로만 통신한다.
const STEPS: { id: string; title: string; how: string }[] = [
  { id: 'install', title: '설치', how: 'Chrome 메뉴 > 홈 화면에 추가(앱 설치)로 설치하고 설치된 아이콘으로 다시 엽니다.' },
  { id: 'permission', title: '알림 허용', how: '“알림 허용 요청”을 누르고 허용합니다. 화면에 권한 granted 가 보이는지 확인합니다.' },
  { id: 'subscribe', title: '푸시 구독', how: '“푸시 구독 등록”을 누릅니다. 오류가 나면 비고에 오류 문구를 적습니다.' },
  { id: 'lockscreen', title: '화면 잠금·앱 닫힘 상태 수신', how: '앱을 닫고 화면을 잠근 뒤, 다른 기기(PC)에서 “시험 알림 1건 보내기”를 누릅니다. 잠금 화면에 알림이 보이는지, 몇 초 걸렸는지 적습니다.' },
  { id: 'replace', title: '같은 알림 교체', how: '알림을 지우지 않은 채 다시 1건 보내 알림이 쌓이지 않고 하나로 보이는지 봅니다(시험마다 키가 달라 새 알림으로 보일 수 있음 — 보이는 그대로 기록).' },
  { id: 'doze', title: '백그라운드·절전', how: '화면을 끈 채 10분 이상 둔 뒤 1건 보냅니다. 배터리 설정이 “제한”인 상태에서도 반복하고 각각 기록합니다.' },
  { id: 'revoke', title: '권한 거부 안내', how: '설정에서 이 앱의 알림을 끄고 앱을 엽니다. 거부 안내가 보이는지 확인한 뒤 알림을 다시 켜고 “권한 다시 확인”을 누릅니다.' },
  { id: 'evidence', title: '화면 캡처·시간 기록', how: '각 단계 화면 캡처를 PM에게 전달하고 표시까지 걸린 시간을 비고에 적습니다.' },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
let token = sessionStorage.getItem('push-token') ?? '';
let lastKey = '';

interface StatusRecord { key: string; status: string; confirmedDelivered: boolean; detail?: string; httpStatus?: number }
interface Status {
  hasSubscription: boolean;
  endpointHost: string | null;
  device: { android: string; chrome: string; model: string } | null;
  records: StatusRecord[];
  observations: { step: string; result: string; note: string }[];
  notice: string;
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(`/api/push/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

const permission = (): string => (supported ? Notification.permission : 'unsupported');
const say = (id: string, text: string, cls = '') => {
  const el = $(id);
  el.textContent = text;
  el.className = `note ${cls}`.trim();
};

function renderEnv(): void {
  const p = permission();
  const label: Record<string, string> = {
    granted: '알림 허용됨',
    default: '아직 허용 여부를 정하지 않음',
    denied: '알림이 꺼져 있음 — 설정 > 앱 > 알림에서 켠 뒤 “권한 다시 확인”',
    unsupported: '이 환경은 알림/푸시를 지원하지 않음 — Android Chrome 설치형 앱으로 열어 주세요',
  };
  $('env').textContent = `권한: ${label[p]} · 보안 연결: ${window.isSecureContext ? '예' : '아니오(HTTPS 필요)'} · 설치형 실행: ${matchMedia('(display-mode: standalone)').matches ? '예' : '아니오'}`;
  $('ask').toggleAttribute('disabled', p !== 'default');
  $('sub').toggleAttribute('disabled', p !== 'granted');
}

function renderStatus(s: Status): void {
  const body = $('log');
  body.innerHTML = '';
  for (const r of [...s.records].reverse()) {
    const tr = document.createElement('tr');
    for (const t of [r.key, r.detail ? `${r.status} (${r.detail})` : r.status, r.confirmedDelivered ? '예' : '아니오 (미확인)']) {
      const td = document.createElement('td');
      td.textContent = t;
      tr.append(td);
    }
    body.append(tr);
  }
  $('notice').textContent = `${s.notice} 구독: ${s.hasSubscription ? `있음(${s.endpointHost})` : '없음'}`;
  if (s.device) {
    ($('android') as HTMLInputElement).value ||= s.device.android;
    ($('chrome') as HTMLInputElement).value ||= s.device.chrome;
    ($('model') as HTMLInputElement).value ||= s.device.model;
  }
  const saved = new Map(s.observations.map((o) => [o.step, o]));
  for (const st of STEPS) {
    const o = saved.get(st.id);
    if (!o) continue;
    const sel = document.querySelector<HTMLSelectElement>(`#step-${st.id} select`);
    const note = document.querySelector<HTMLTextAreaElement>(`#step-${st.id} textarea`);
    if (sel && !sel.dataset.touched) sel.value = o.result;
    if (note && !note.dataset.touched) note.value = o.note;
    document.querySelector(`#step-${st.id} .saved`)!.textContent = `저장됨: ${o.result}`;
  }
}

async function refresh(): Promise<void> {
  const r = await api<Status>('GET', 'status');
  if (r.ok) renderStatus(r.data);
}

function buildSteps(): void {
  const host = $('steps');
  STEPS.forEach((st, i) => {
    const f = document.createElement('fieldset');
    f.id = `step-${st.id}`;
    const lg = document.createElement('legend');
    lg.textContent = `${i + 1}. ${st.title}`;
    const how = document.createElement('p');
    how.className = 'note';
    how.textContent = st.how;
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `${st.title} 결과`);
    for (const [v, t] of [['OK', '확인됨'], ['FAIL', '안 됨'], ['NOT_APPLICABLE', '해당 없음']]) sel.append(new Option(t, v));
    sel.addEventListener('change', () => (sel.dataset.touched = '1'));
    const note = document.createElement('textarea');
    note.maxLength = 500;
    note.rows = 2;
    note.placeholder = '비고: 걸린 시간, 오류 문구 등 (개인 내용 금지)';
    note.setAttribute('aria-label', `${st.title} 비고`);
    note.addEventListener('input', () => (note.dataset.touched = '1'));
    const save = document.createElement('button');
    save.textContent = '이 단계 저장';
    const saved = document.createElement('span');
    saved.className = 'saved note';
    saved.setAttribute('role', 'status');
    save.addEventListener('click', async () => {
      const r = await api('PUT', 'observations', { step: st.id, result: sel.value, note: note.value });
      saved.textContent = r.ok ? `저장됨: ${sel.value}` : `저장 실패 (${r.status})`;
      if (r.ok) await refresh();
    });
    f.append(lg, how, sel, note, save, saved);
    host.append(f);
  });
}

const b64ToBytes = (v: string) => Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bytesToB64Url = (b: ArrayBuffer | null) => (b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '');

async function reportDisplayedFromTray(): Promise<void> {
  if (!supported) return;
  const reg = await navigator.serviceWorker.getRegistration();
  for (const n of (await reg?.getNotifications()) ?? []) {
    const key = (n.data as { key?: string } | null)?.key;
    if (key?.startsWith('test:')) await api('POST', 'displayed', { key });
  }
}

$('connect').addEventListener('click', async () => {
  token = ($('token') as HTMLInputElement).value.trim();
  sessionStorage.setItem('push-token', token);
  const r = await api('GET', 'status');
  if (r.status === 401) say('conn', '토큰이 올바르지 않습니다.', 'bad');
  else if (r.status === 429) say('conn', '실패가 너무 많아 잠시 막혔습니다. 1분 뒤 다시 시도하세요.', 'bad');
  else if (r.status === 503) say('conn', '서버에서 푸시 기능이 꺼져 있습니다(설정 필요).', 'bad');
  else if (r.ok) {
    say('conn', '연결됨', 'ok');
    await reportDisplayedFromTray();
    await refresh();
  } else say('conn', `연결 실패 (${r.status})`, 'bad');
});

$('save-dev').addEventListener('click', async () => {
  const v = (id: string) => ($(id) as HTMLInputElement).value.trim();
  const r = await api('PUT', 'device', { android: v('android'), chrome: v('chrome'), model: v('model') });
  say('conn', r.ok ? '기기 정보 저장됨' : `기기 정보 저장 실패 (${r.status})`, r.ok ? 'ok' : 'bad');
});

$('ask').addEventListener('click', async () => {
  if (supported) await Notification.requestPermission();
  renderEnv();
});
$('recheck').addEventListener('click', renderEnv);

$('sub').addEventListener('click', async () => {
  try {
    const k = await api<{ publicKey: string }>('GET', 'vapid-public-key');
    if (!k.ok) return say('perm-msg', `서버 키를 받지 못했습니다 (${k.status})`, 'bad');
    const reg = await navigator.serviceWorker.register('/sw-notify.js');
    await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.data.publicKey) });
    const r = await api('PUT', 'subscription', {
      endpoint: sub.endpoint,
      keys: { p256dh: bytesToB64Url(sub.getKey('p256dh')), auth: bytesToB64Url(sub.getKey('auth')) },
    });
    say('perm-msg', r.ok ? '구독 등록됨' : `서버가 구독을 거부했습니다 (${r.status})`, r.ok ? 'ok' : 'bad');
  } catch (e) {
    say('perm-msg', `푸시 구독 실패: ${e instanceof Error ? e.name : 'error'} (전달 가능 상태 아님)`, 'bad');
  }
  await refresh();
});

$('unsub').addEventListener('click', async () => {
  const reg = await navigator.serviceWorker?.getRegistration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
  const r = await api('DELETE', 'subscription');
  say('perm-msg', r.ok ? '구독 해제됨' : `해제 실패 (${r.status})`);
  await refresh();
});

let sending = false;
$('send').addEventListener('click', async () => {
  if (sending) return;
  sending = true;
  $('send').setAttribute('disabled', '');
  try {
    const r = await api<{ status?: string; key?: string; duplicate?: boolean; error?: string }>('POST', 'test', { requestId: crypto.randomUUID() });
    if (r.status === 429) say('send-msg', '30초 안에는 다시 보낼 수 없습니다.', 'bad');
    else if (!r.ok) say('send-msg', `발송 실패 (${r.status}${r.data.error ? ` ${r.data.error}` : ''})`, 'bad');
    else {
      lastKey = r.data.key ?? '';
      say('send-msg', `${r.data.status} — 기기에 알림이 보이기 전까지는 전달 미확인입니다.`);
    }
  } finally {
    sending = false;
    $('send').removeAttribute('disabled');
    await refresh();
  }
});

$('confirm').addEventListener('click', async () => {
  const s = await api<Status>('GET', 'status');
  const key = lastKey || [...(s.data.records ?? [])].reverse().find((r) => r.status === 'PUSH_SERVICE_ACCEPTED')?.key || '';
  if (!key) return say('send-msg', '확인할 접수된 시험 알림이 없습니다.', 'bad');
  const r = await api('POST', 'displayed', { key });
  say('send-msg', r.ok ? '기기 표시 확인이 기록되었습니다.' : `기록 실패 (${r.status})`, r.ok ? 'ok' : 'bad');
  await refresh();
});

if (supported) {
  navigator.serviceWorker.addEventListener('message', async (e) => {
    if (e.data?.type === 'displayed') {
      say('send-msg', '이 기기의 서비스 워커가 알림을 표시했습니다. 눈으로 보였다면 “알림이 보였습니다”를 누르세요.', 'ok');
      await refresh();
    }
  });
}

buildSteps();
renderEnv();
if (token) {
  ($('token') as HTMLInputElement).value = token;
  void refresh().then(() => reportDisplayedFromTray());
}
