import { useCallback, useEffect, useState } from 'react';
import { SCOPE_LABEL, SCOPE_NOTICE, commandError, fetchJson, postCommand, remainingLabel, type Loaded, type TrashEntry } from './records';

const base = (e: TrashEntry) => (e.scope === 'RECORD' ? `/api/records/${e.id}` : `/api/records/${e.recordId}/${e.scope === 'ITEM' ? 'items' : 'attachments'}/${e.id}`);

/** 삭제 확인. 되돌릴 수 있는지, 무엇이 지워지고 무엇이 남는지를 먼저 말한 뒤 실행한다. */
export function ConfirmBox({ title, children, confirmLabel, danger, busy, onConfirm, onCancel }: {
  title: string; children: React.ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div role="alertdialog" aria-labelledby="confirm-title" className="card confirm" data-testid="confirm-box">
      <strong id="confirm-title">{title}</strong>
      {children}
      <p>
        <button className={danger ? 'danger' : undefined} data-testid="confirm-yes" disabled={busy} onClick={onConfirm}>{busy ? '처리 중' : confirmLabel}</button>{' '}
        <button data-testid="confirm-no" disabled={busy} onClick={onCancel} autoFocus>취소</button>
      </p>
    </div>
  );
}

/** 휴지통: 30일 안에 복구하거나 지금 영구 삭제한다. 영구 삭제는 2단계 확인이다. */
export function TrashView({ onBack }: { onBack: () => void }) {
  const [r, setR] = useState<Loaded<{ entries: TrashEntry[] }> | null>(null);
  const [purging, setPurging] = useState<TrashEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { setR(null); void fetchJson<{ entries: TrashEntry[] }>('/api/trash').then(setR); }, []);
  useEffect(load, [load]);
  const run = async (url: string, body?: object) => {
    setBusy(true);
    const res = await postCommand(url, body);
    setBusy(false);
    setPurging(null);
    setMsg(res.ok ? null : commandError(res.code));
    load();
  };
  return (
    <section data-testid="screen-trash">
      <button onClick={onBack}>← 목록</button>
      <h3>휴지통</h3>
      <p data-testid="scope-notice">{SCOPE_NOTICE}</p>
      <p>삭제한 날부터 30일 동안만 복구할 수 있고, 그 뒤에는 서버에서 영구 삭제됩니다.</p>
      {msg && <p role="alert" data-testid="trash-error">{msg}</p>}
      {!r && <p>불러오는 중</p>}
      {r && r.state !== 'ok' && <div role="alert"><p>휴지통을 불러오지 못했습니다.</p><button onClick={load}>다시 불러오기</button></div>}
      {r?.state === 'ok' && (r.data.entries.length === 0 ? <p data-testid="trash-empty">휴지통이 비어 있습니다.</p> : (
        <ul className="records" data-testid="trash-list" aria-label="휴지통">
          {r.data.entries.map((e) => (
            <li key={`${e.scope}-${e.id}`} data-scope={e.scope} data-can-restore={e.canRestore ? 'true' : 'false'}>
              <strong>{e.lifeDate}</strong> · {SCOPE_LABEL[e.scope]} · {e.label}
              {e.preview && <span> “{e.preview}”</span>}
              <div data-testid="remaining">{remainingLabel(e.purgeAt)}</div>
              <div>
                {e.canRestore && <button data-testid="restore" disabled={busy} onClick={() => void run(`${base(e)}/restore`)}>복구</button>}{' '}
                <button data-testid="purge" disabled={busy} onClick={() => setPurging(e)}>영구 삭제</button>
              </div>
            </li>
          ))}
        </ul>
      ))}
      {purging && (
        <ConfirmBox title={`${purging.lifeDate} ${SCOPE_LABEL[purging.scope]}를 영구 삭제할까요?`} confirmLabel="영구 삭제" danger busy={busy}
          onConfirm={() => void run(`${base(purging)}/purge`, { confirm: true })} onCancel={() => setPurging(null)}>
          <p data-testid="purge-warning">영구 삭제하면 서버에서 복구할 수 없습니다. {SCOPE_NOTICE}</p>
        </ConfirmBox>
      )}
    </section>
  );
}
