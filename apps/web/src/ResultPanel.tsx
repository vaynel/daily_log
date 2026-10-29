import { useCallback, useEffect, useRef, useState } from 'react';
import { canRevise, fetchJson, FILE_MISSING_ACTIONS, newCommandId, postJson, resultFileUrl, revisionMessage, STATUS_INFO, type Loaded, type RecordDetail, type ResultsInfo, type RevisionBody } from './records';

type SpeechCtor = new () => { lang: string; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; start(): void };
const speechCtor = (): SpeechCtor | null => {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/** 완성 결과 확인·재생·내려받기와 버튼·음성 수정. 재생과 내려받기는 서버가 COMPLETED 로 판정한 현재 결과에만 보인다. */
export function ResultPanel({ d, onChanged }: { d: RecordDetail; onChanged: () => void }) {
  const [r, setR] = useState<Loaded<ResultsInfo> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null);
  const [cmd, setCmd] = useState('');
  const [listening, setListening] = useState(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const load = useCallback(() => { void fetchJson<ResultsInfo>(`/api/records/${d.id}/results`).then(setR); }, [d.id]);
  useEffect(load, [load, d.status]);

  const send = async (body: RevisionBody, key: string) => {
    if (busy) return;
    setBusy(true);
    // 같은 동작을 다시 보낼 때(연결 오류 재시도 등)는 같은 명령 식별자를 써 중복 접수를 막는다.
    const commandId = pending.current?.key === key ? pending.current.id : newCommandId();
    pending.current = { key, id: commandId };
    const res = await postJson(`/api/records/${d.id}/revisions`, { commandId, ...body });
    if (res.ok || res.status !== 0) pending.current = null;
    setMsg(revisionMessage(res));
    setBusy(false);
    if (res.ok) { setEdit(null); setCmd(''); onChanged(); }
  };
  const confirm = async (version: number) => {
    const res = await postJson(`/api/records/${d.id}/result/confirm`, { version });
    setMsg(res.ok ? '결과를 확인했습니다.' : '지금은 확인할 수 없는 결과입니다.');
    load();
  };
  const listen = () => {
    const C = speechCtor();
    if (!C) { setMsg('이 기기에서는 음성 입력을 쓸 수 없습니다. 아래 칸에 직접 적어 주세요.'); return; }
    const rec = new C();
    rec.lang = 'ko-KR';
    rec.onresult = (e) => { setCmd(e.results[0]?.[0]?.transcript ?? ''); setListening(false); };
    rec.onerror = () => { setListening(false); setMsg('음성을 알아듣지 못했습니다. 직접 적어도 됩니다.'); };
    setListening(true);
    rec.start();
  };

  const info = STATUS_INFO[d.status];
  const data = r?.state === 'ok' ? r.data : null;
  const current = data?.versions.find((v) => v.role === 'CURRENT') ?? null;
  const previous = data?.versions.filter((v) => v.role === 'PREVIOUS') ?? [];

  return (
    <section data-testid="result-panel" aria-label="결과 확인과 수정">
      <h4>결과 영상</h4>
      {d.status === 'COMPLETED' && current?.playable ? (
        <>
          <video data-testid="result-video" controls playsInline preload="metadata" src={resultFileUrl(d.id, current.version)} style={{ width: '100%', maxWidth: 360 }} />
          <p>
            <a className="button" data-testid="download-result" href={resultFileUrl(d.id, current.version, true)} download>영상 내려받기</a>{' '}
            {current.confirmedAt
              ? <span data-testid="result-confirmed">확인함</span>
              : <button data-testid="confirm-result" onClick={() => void confirm(current.version)}>확인했어요</button>}
          </p>
        </>
      ) : d.status === 'RESULT_FILE_MISSING' ? (
        <div role="alert" data-testid="result-file-missing">
          <p><strong>결과 파일을 찾을 수 없어 재생하거나 내려받을 수 없습니다.</strong> 검수는 끝났지만 완료로 볼 수 없습니다.</p>
          <ul data-testid="missing-actions">{FILE_MISSING_ACTIONS.map((a) => <li key={a}>{a}</li>)}</ul>
          <button data-testid="reload-result" onClick={() => { load(); onChanged(); }}>다시 불러오기</button>
        </div>
      ) : (
        <p data-testid="result-notice" role="status">{info.label}: {info.hint} 이 상태의 영상은 재생하거나 내려받을 수 없습니다.</p>
      )}
      {msg && <p role="status" data-testid="revision-message">{msg}</p>}

      {canRevise(d.status) && (
        <div data-testid="revise">
          <h4>영상 수정</h4>
          <p>수정하면 관련된 장면·내레이션·자막을 함께 다시 만들고, 지금 영상은 이전 버전이 됩니다.</p>
          {data?.items.length ? (
            <ul data-testid="plan-items">
              {data.items.map((it) => (
                <li key={it.id}>
                  {edit?.id === it.id ? (
                    <>
                      <textarea aria-label="문장 고치기" value={edit.text} maxLength={500} onChange={(e) => setEdit({ id: it.id, text: e.target.value })} />
                      <button disabled={busy} data-testid="save-edit" onClick={() => void send({ kind: 'EDIT_TEXT', itemId: it.id, text: edit.text }, `edit:${it.id}:${edit.text}`)}>고쳐서 다시 만들기</button>
                      <button onClick={() => setEdit(null)}>취소</button>
                    </>
                  ) : (
                    <>
                      {it.text}{' '}
                      <button disabled={busy} data-testid="edit-item" onClick={() => setEdit({ id: it.id, text: it.text })}>고치기</button>
                      <button disabled={busy} data-testid="exclude-item" onClick={() => void send({ kind: 'EXCLUDE', itemId: it.id }, `ex:${it.id}`)}>영상에서 빼기</button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <label>말이나 글로 요청하기
            <input data-testid="voice-text" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder='예: "점심" 부분은 영상에서 빼줘' maxLength={300} />
          </label>
          <button disabled={listening} data-testid="voice-listen" onClick={listen}>{listening ? '듣는 중' : '🎤 말하기'}</button>
          <button disabled={busy || !cmd.trim()} data-testid="voice-send" onClick={() => void send({ kind: 'VOICE', text: cmd.trim() }, `v:${cmd.trim()}`)}>요청하기</button>
          {d.status === 'FAILED' && <p><button disabled={busy} data-testid="retry" onClick={() => void send({ kind: 'RETRY' }, 'retry')}>다시 시도</button></p>}
        </div>
      )}

      {previous.length > 0 && (
        <div data-testid="previous-versions">
          <h4>이전 버전</h4>
          <ul>
            {previous.map((v) => (
              <li key={v.version} data-version={v.version}>
                버전 {v.version} · 이전 버전(수정으로 대체됨, 현재 완성본 아님)
                {v.playable ? <> · <a href={resultFileUrl(d.id, v.version)} target="_blank" rel="noreferrer">재생</a> · <a href={resultFileUrl(d.id, v.version, true)} download>내려받기</a></> : ' · 재생·내려받기 불가'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
