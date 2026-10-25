import { useCallback, useEffect, useState } from 'react';
import { DELIVERY_LABEL, KIND_LABEL, PERMISSION_INFO, currentPermission, isValidTime, urlBase64ToUint8Array, type NotifyItem, type NotifySettings as Settings, type Permission } from './notify';

const json = { 'content-type': 'application/json' };

/** 인터뷰 알림 시각 설정, 알림 권한 상태, 최근 알림 전달 결과. 전달 실패는 기록·제작 상태와 별개임을 안내한다. */
export function NotifySettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [recent, setRecent] = useState<NotifyItem[]>([]);
  const [time, setTime] = useState('22:00');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [permission, setPermission] = useState<Permission>('unknown');

  const load = useCallback(async () => {
    const [s, st] = await Promise.all([fetch('/api/notifications/settings'), fetch('/api/notifications/status')]);
    if (!s.ok) throw new Error('settings');
    const next = (await s.json()) as Settings;
    setSettings(next);
    setTime(next.interviewTime);
    setPermission(currentPermission());
    if (st.ok) setRecent(((await st.json()) as { recent: NotifyItem[] }).recent);
  }, []);
  useEffect(() => { void load().catch(() => setError('알림 설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.')); }, [load]);

  const saveTime = async () => {
    setMsg(''); setError('');
    if (!isValidTime(time)) { setError('시각은 24시간 형식(예: 22:00)으로 입력하세요.'); return; }
    const r = await fetch('/api/notifications/settings', { method: 'PUT', headers: json, body: JSON.stringify({ interviewTime: time }) });
    if (!r.ok) { setError('저장하지 못했습니다. 다시 시도해 주세요.'); return; }
    setSettings({ ...(settings as Settings), ...(await r.json()) });
    setMsg(`매일 ${time}(한국 시간)에 알려 드립니다.`);
  };

  /** 권한을 요청·재확인하고 허용되면 이 기기를 구독한다. 결과 권한은 서버에 보고한다. */
  const enable = async () => {
    setMsg(''); setError('');
    let p = currentPermission();
    try {
      if (p === 'default') p = (await Notification.requestPermission()) as Permission;
      await fetch('/api/notifications/permission', { method: 'PUT', headers: json, body: JSON.stringify({ permission: p }) });
      if (p === 'granted' && settings?.vapidPublicKey) {
        const reg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(settings.vapidPublicKey) as BufferSource }));
        const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
        const r = await fetch('/api/notifications/subscription', { method: 'PUT', headers: json, body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) });
        if (!r.ok) throw new Error('subscribe');
      } else if (p === 'granted') {
        setError('서버에 알림 발송 설정이 아직 없습니다. 관리자에게 문의하세요.');
      }
      await load();
    } catch {
      setError('알림을 연결하지 못했습니다. 권한을 확인한 뒤 다시 시도해 주세요.');
    }
  };

  const info = PERMISSION_INFO[permission];
  return (
    <section data-testid="notify-settings" className="attach">
      <h3>알림</h3>
      {!settings && !error && <p>불러오는 중</p>}
      {settings && (
        <>
          <p>
            <label>인터뷰 알림 시각(한국 시간){' '}
              <input data-testid="notify-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>{' '}
            <button data-testid="notify-save" onClick={() => void saveTime()}>저장</button>
          </p>
          <p data-testid="notify-permission">알림 권한: <strong>{info.label}</strong> — {info.hint}</p>
          <p data-testid="notify-subscribed">이 기기 연결: {settings.subscribed ? '연결됨' : '연결 안 됨'}</p>
          {permission !== 'unsupported' && (permission !== 'granted' || !settings.subscribed) ? (
            <button data-testid="notify-enable" onClick={() => void enable()}>{permission === 'denied' ? '권한 다시 확인' : '알림 허용하고 연결'}</button>
          ) : null}
          {recent.length > 0 && (
            <ul data-testid="notify-recent" className="attach-list">
              {recent.slice(0, 5).map((n) => (
                <li key={n.id}>
                  {KIND_LABEL[n.kind] ?? n.kind}{n.lifeDate ? ` (${n.lifeDate})` : ''}: {DELIVERY_LABEL[n.status] ?? n.status}
                  {n.guidance && <div role="alert">{n.guidance}</div>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {msg && <p data-testid="notify-msg">{msg}</p>}
      {error && <p role="alert" data-testid="notify-error">{error}</p>}
    </section>
  );
}
