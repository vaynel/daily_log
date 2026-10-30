import { useCallback, useEffect, useState } from 'react';
import { BACKUP_KEPT_TEXT, commandErrorText, fetchJson, postJson, trashRemaining, type Loaded, type TrashData } from './records';

/**
 * 휴지통: 삭제한 기록·항목·첨부를 30일 안에 복구하거나 지금 서버에서 영구 삭제한다.
 * 영구 삭제는 2단계 확인(되돌릴 수 없음)이며, 모든 문구는 서버 사본만 대상이고 Drive 백업·완성 영상은 유지됨을 함께 알린다.
 */
export function TrashView({ onBack, onChanged }: { onBack: () => void; onChanged?: () => void }) {
  const [r, setR] = useState<Loaded<TrashData> | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setR(null); void fetchJson<TrashData>('/api/trash').then(setR); }, []);
  useEffect(load, [load]);

  const run = async (url: string, body: unknown, okText: string) => {
    setBusy(true);
    const res = await postJson(url, body);
    setBusy(false);
    setConfirming(null);
    if (res.ok) { setMsg({ tone: 'ok', text: okText }); onChanged?.(); } else setMsg({ tone: 'bad', text: commandErrorText(res.code) });
    load();
  };

  return (
    <section data-testid="screen-trash" aria-labelledby="trash-h">
      <button onClick={onBack}>← 기록</button>
      <h3 id="trash-h">휴지통</h3>
      <p data-testid="trash-note">삭제한 기록은 30일 동안 휴지통에 보관되며 그 안에는 복구할 수 있습니다. 여기서의 삭제는 이 앱 서버의 사본만 지웁니다. {BACKUP_KEPT_TEXT}</p>
      {msg && <p role={msg.tone === 'bad' ? 'alert' : 'status'} data-testid="trash-message" data-tone={msg.tone}>{msg.text}</p>}
      {!r && <p>불러오는 중</p>}
      {r && r.state === 'expired' && <p role="alert" data-testid="screen-access-expired">접근이 만료되었습니다. <a className="button" href="/auth/login">Google로 다시 로그인</a></p>}
      {r && (r.state === 'error' || r.state === 'not-found') && <p role="alert" data-testid="screen-load-error">불러오지 못했습니다. <button onClick={load}>다시 불러오기</button></p>}
      {r?.state === 'ok' && (r.data.records.length === 0 && r.data.parts.length === 0
        ? <p data-testid="trash-empty">휴지통이 비어 있습니다.</p>
        : (
          <>
            {r.data.records.length > 0 && (
              <ul data-testid="trash-records" aria-label="휴지통의 기록" className="records">
                {r.data.records.map((x) => (
                  <li key={x.id} data-life-date={x.lifeDate}>
                    <strong>{x.lifeDate}</strong> · <span data-testid="trash-remaining">{trashRemaining(x.daysLeft, x.restorable)}</span>
                    <div className="actions">
                      {x.restorable && <button disabled={busy} data-testid="restore" onClick={() => void run(`/api/records/${x.id}/restore`, {}, `${x.lifeDate} 기록을 복구했습니다.`)}>복구</button>}
                      {confirming === x.id ? (
                        <span role="alertdialog" aria-label={`${x.lifeDate} 영구 삭제 확인`} data-testid="purge-confirm">
                          <span>{x.lifeDate} 기록의 서버 사본을 지금 영구 삭제합니다. 복구할 수 없습니다. {BACKUP_KEPT_TEXT}</span>
                          <button disabled={busy} className="danger" data-testid="purge-yes" onClick={() => void run(`/api/records/${x.id}/purge`, { confirm: true }, `${x.lifeDate} 기록의 서버 사본을 삭제했습니다. ${BACKUP_KEPT_TEXT}`)}>영구 삭제</button>
                          <button disabled={busy} data-testid="purge-no" onClick={() => setConfirming(null)}>취소</button>
                        </span>
                      ) : <button disabled={busy} data-testid="purge" onClick={() => setConfirming(x.id)}>지금 영구 삭제…</button>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {r.data.parts.length > 0 && (
              <>
                <h4>삭제한 일부 항목</h4>
                <ul data-testid="trash-parts" aria-label="휴지통의 일부 항목">
                  {r.data.parts.map((x) => (
                    <li key={x.id}>
                      {x.lifeDate} · {x.kind === 'ITEM' ? '대화 항목' : `첨부${x.name ? ` ${x.name}` : ''}`} · {trashRemaining(x.daysLeft, x.restorable)}
                      {x.restorable && <button disabled={busy} data-testid="restore-part" onClick={() => void run(`/api/records/${x.interviewId}/${x.kind === 'ITEM' ? 'items' : 'attachments'}/${x.id}/restore`, {}, '복구했습니다.')}>복구</button>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ))}
    </section>
  );
}
