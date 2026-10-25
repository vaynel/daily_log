import { useCallback, useEffect, useState } from 'react';
import { afterCorrection, confirmBriefing, correctBriefing, loadBriefing, startBriefing, type BriefingData } from './briefing';

function speak(text: string) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text); u.lang = 'ko-KR';
  window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
}

/**
 * 대화를 마친 뒤 하루 요약과 영상 핵심을 한 화면에서 보여 주고, [확인]을 누르기 전에는 영상 제작을 시작하지 않는다.
 * 고칠 때는 해당 항목만 바꾸고 전체를 다시 읽어 주지 않는다.
 */
export function BriefingPanel({ recordId }: { recordId: string }) {
  const [data, setData] = useState<BriefingData | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [lastChange, setLastChange] = useState('');

  useEffect(() => { void loadBriefing(recordId).then((r) => { if (r.ok) setData(r.data); }); }, [recordId]);

  const start = useCallback(async () => {
    setBusy(true); setMsg('정리하는 중…');
    const r = await startBriefing(recordId);
    setBusy(false);
    if (r.ok) { setData(r.data); setMsg(''); if (!r.data.confirmed) speak(r.data.speech); } else setMsg(r.message);
  }, [recordId]);

  const correct = async (itemId: string, action: 'EXCLUDE' | 'REPLACE' | 'INCLUDE', text?: string) => {
    if (!data) return;
    setBusy(true);
    const r = await correctBriefing(recordId, data.version, itemId, action, text);
    setBusy(false);
    if (!r.ok) { setMsg(r.message); if (r.code === 'STALE_BRIEFING') { const l = await loadBriefing(recordId); if (l.ok) setData(l.data); } return; }
    const a = afterCorrection(r.data);
    setData(a.data); setEditing(null); setMsg(''); setLastChange(a.speak); speak(a.speak);
  };

  const confirm = async () => {
    if (!data) return;
    setBusy(true); setMsg('');
    const r = await confirmBriefing(recordId, data.version);
    setBusy(false);
    if (r.ok) { setData({ ...data, confirmed: true }); setMsg('확인했습니다. 영상 제작을 요청했습니다.'); } else { setMsg(r.message); if (r.code === 'STALE_BRIEFING') { const l = await loadBriefing(recordId); if (l.ok) setData(l.data); } }
  };

  return (
    <section data-testid="briefing" aria-labelledby="br-h" className="briefing">
      <h3 id="br-h">오늘 브리핑</h3>
      {!data && <button data-testid="btn-briefing-start" className="button" disabled={busy} onClick={() => void start()}>브리핑 보기</button>}
      <p data-testid="br-msg" role="status" aria-live="polite">{msg}</p>
      {data && (
        <>
          <h4>하루 요약</h4>
          <ul data-testid="br-summary">{data.summary.map((s) => <li key={s.id}>{s.text}</li>)}</ul>
          <h4>영상에 담을 내용</h4>
          {data.video.length === 0 && <p data-testid="br-video-empty" className="meta">영상에 담을 내용이 없습니다.</p>}
          <ul data-testid="br-video">
            {data.video.map((v) => (
              <li key={v.id} data-id={v.id}>
                {editing?.id === v.id ? (
                  <>
                    <label htmlFor={`br-edit-${v.id}`}>고칠 문장</label>
                    <input id={`br-edit-${v.id}`} data-testid="br-edit" value={editing.text} onChange={(e) => setEditing({ id: v.id, text: e.target.value })} />
                    <button data-testid="br-edit-save" disabled={busy || !editing.text.trim()} onClick={() => void correct(v.id, 'REPLACE', editing.text)}>저장</button>
                    <button onClick={() => setEditing(null)}>취소</button>
                  </>
                ) : (
                  <>
                    {v.text}{' '}
                    {!data.confirmed && <>
                      <button data-testid="br-fix" aria-label={`고치기: ${v.text}`} onClick={() => setEditing({ id: v.id, text: v.text })}>고치기</button>{' '}
                      <button data-testid="br-drop" aria-label={`영상에서 빼기: ${v.text}`} disabled={busy} onClick={() => void correct(v.id, 'EXCLUDE')}>영상에서 빼기</button>
                    </>}
                  </>
                )}
              </li>
            ))}
          </ul>
          {data.excluded.length > 0 && (
            <>
              <h4>영상에서 뺀 내용 <span className="meta">(기록에는 남아 있습니다)</span></h4>
              <ul data-testid="br-excluded">
                {data.excluded.map((x) => (
                  <li key={x.id}>{x.text} <span className="meta">— {x.label}</span>{' '}
                    {x.reason === 'USER' && !data.confirmed && <button data-testid="br-restore" disabled={busy} onClick={() => void correct(x.id, 'INCLUDE')}>다시 넣기</button>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {lastChange && <p data-testid="br-change" role="status">{lastChange}</p>}
          <div className="iv-actions">
            {'speechSynthesis' in window && <button data-testid="br-listen" onClick={() => speak(data.speech)}>전체 음성으로 듣기</button>}
            {!data.confirmed && <button data-testid="br-confirm" className="button" disabled={busy || data.video.length === 0} onClick={() => void confirm()}>확인하고 영상 만들기</button>}
          </div>
          {data.confirmed
            ? <p data-testid="br-confirmed" role="status">확인 완료. 영상 제작이 요청되었습니다.</p>
            : <p className="meta">확인을 누르기 전에는 영상이 만들어지지 않습니다.</p>}
        </>
      )}
    </section>
  );
}
