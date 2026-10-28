import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, newCommandId, resultFileUrl, resultProblem, sendRevision, versionLabel, type Loaded, type RecordDetail, type ResultVersion, type ReviseBody } from './records';

interface SpeechRec { lang: string; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start(): void; stop(): void }
const speechCtor = (): (new () => SpeechRec) | null => {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/** 결과 영상 확인(재생·내려받기·파일 없음·미통과), 수정 요청, 결과 버전 목록. 상태 판단은 서버가 준 status 만 따른다. */
export function ResultPanel({ d, onChanged }: { d: RecordDetail; onChanged: () => void }) {
  const [versions, setVersions] = useState<Loaded<{ versions: ResultVersion[] }> | null>(null);
  const loadVersions = useCallback(() => { void fetchJson<{ versions: ResultVersion[] }>(`/api/records/${d.id}/results`).then(setVersions); }, [d.id]);
  useEffect(loadVersions, [loadVersions, d.status, d.result?.version]);
  const [msg, setMsg] = useState<{ tone: 'info' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [voice, setVoice] = useState('');
  const [voiceItem, setVoiceItem] = useState('');
  const [listening, setListening] = useState(false);
  const rec = useRef<SpeechRec | null>(null);
  const cmd = useRef<{ key: string; id: string } | null>(null);

  // 같은 요청을 다시 보낼 때(네트워크 재시도)는 같은 명령 식별자를 쓰고, 내용이 바뀌면 새로 만든다.
  const idFor = (key: string) => { if (cmd.current?.key !== key) cmd.current = { key, id: newCommandId() }; return cmd.current.id; };
  const run = async (key: string, body: Omit<ReviseBody, 'commandId'>, okText: string) => {
    setBusy(true); setMsg(null);
    const r = await sendRevision(d.id, { ...body, commandId: idFor(key) });
    setBusy(false);
    if (r.state === 'done') { cmd.current = null; setEditing(null); setMsg({ tone: 'info', text: okText }); onChanged(); loadVersions(); }
    else if (r.state === 'not-executed') { cmd.current = null; setMsg({ tone: 'info', text: r.message }); }
    else setMsg({ tone: 'bad', text: r.message });
  };
  const confirm = async () => {
    if (!d.result) return;
    setBusy(true);
    const r = await fetch(`/api/records/${d.id}/result/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: d.result.version, commandId: newCommandId() }) }).catch(() => null);
    setBusy(false);
    if (r?.ok) onChanged(); else setMsg({ tone: 'bad', text: '확인을 기록하지 못했습니다. 다시 시도해 주세요.' });
  };
  const listen = () => {
    const C = speechCtor();
    if (!C) { setMsg({ tone: 'info', text: '이 기기에서는 음성 입력을 쓸 수 없습니다. 아래 칸에 직접 입력해 주세요.' }); return; }
    if (listening) { rec.current?.stop(); return; }
    const r = new C(); r.lang = 'ko-KR';
    r.onresult = (e) => setVoice(e.results[0]?.[0]?.transcript ?? '');
    r.onerror = () => { setListening(false); setMsg({ tone: 'bad', text: '음성을 알아듣지 못했습니다. 마이크 권한을 확인하거나 직접 입력해 주세요.' }); };
    r.onend = () => setListening(false);
    rec.current = r; setListening(true); r.start();
  };

  const problem = resultProblem(d.status, !!d.result?.fileAvailable);
  const canRevise = d.nextActions.includes('EDIT_AND_REMAKE');
  const items = d.editableItems.filter((i) => i.inVideo);
  const droppedItems = d.editableItems.filter((i) => !i.inVideo);

  return (
    <section data-testid="result-panel" aria-labelledby="result-h">
      <h4 id="result-h">결과 영상</h4>
      {d.result?.playable && (
        <>
          <video data-testid="result-video" controls playsInline preload="metadata" src={resultFileUrl(d.id, d.result.version, true)} style={{ width: '100%', maxHeight: '70vh', background: '#000' }}>
            이 브라우저에서는 영상을 재생할 수 없습니다. 아래 내려받기를 이용해 주세요.
          </video>
          <p>
            <a className="button" data-testid="download-result" href={resultFileUrl(d.id, d.result.version, false)} download>영상 내려받기</a>
            {d.result.confirmedAt
              ? <span data-testid="result-confirmed" role="status">확인함 ({new Date(d.result.confirmedAt).toLocaleString('ko-KR')})</span>
              : <button data-testid="confirm-result" disabled={busy} onClick={() => void confirm()}>영상 확인했어요</button>}
          </p>
          {!d.result.confirmedAt && <p className="meta" data-testid="unconfirmed-note">아직 확인하지 않은 결과입니다. 시간이 지나도 자동으로 확인되거나 공개되지 않습니다.</p>}
        </>
      )}
      {!d.result && d.status === 'PRODUCING' && d.previousResultCount > 0 && <p role="status" data-testid="remaking">수정한 영상을 만들고 있습니다. 이전 버전은 아래에서 볼 수 있지만 완성본으로 바뀌지 않습니다.</p>}
      {problem && (
        <div role="alert" className="problem" data-testid={d.status === 'REVIEW_REJECTED' ? 'result-rejected' : d.status === 'FAILED' ? 'result-failed' : d.status === 'REVIEW_PENDING' ? 'result-pending' : 'result-file-missing'}>
          <p><strong>{problem.reason}</strong></p>
          <p>{problem.action}</p>
          {!!d.pipeline.qualityReasons?.length && <p className="meta">검수에서 막힌 이유가 {d.pipeline.qualityReasons.length}건 있습니다.</p>}
        </div>
      )}
      {d.nextActions.includes('RETRY') && <button data-testid="retry-production" disabled={busy} onClick={() => void run('retry', { kind: 'RETRY' }, '다시 시도를 요청했습니다. 제작이 끝나면 이 화면에 표시됩니다.')}>다시 시도</button>}
      {msg && <p role="status" data-testid="revise-message" className={msg.tone === 'bad' ? 'notice bad' : 'notice'}>{msg.text}</p>}

      {canRevise && (
        <details data-testid="revise-panel" open={d.status !== 'COMPLETED'}>
          <summary>수정해서 다시 만들기</summary>
          <p className="meta">영상에서만 바뀌고, 대화 원본과 기록은 지워지지 않습니다. 장면·내레이션·자막이 함께 다시 만들어지며, 새 영상이 검수를 통과하기 전에는 완료로 표시되지 않습니다.</p>
          <ul className="revise-items" data-testid="revise-items">
            {items.map((i) => (
              <li key={i.id}>
                {editing === i.id ? (
                  <>
                    <label htmlFor={`edit-${i.id}`}>고칠 문장</label>
                    <textarea id={`edit-${i.id}`} value={draft} maxLength={300} onChange={(e) => setDraft(e.target.value)} />
                    <button disabled={busy || !draft.trim()} onClick={() => void run(`edit:${i.id}:${draft}`, { kind: 'EDIT_TEXT', itemId: i.id, text: draft }, '수정한 문장으로 영상을 다시 만들고 있습니다.')}>고쳐서 다시 만들기</button>
                    <button onClick={() => setEditing(null)}>취소</button>
                  </>
                ) : (
                  <>
                    <span>{i.text}</span>
                    <button aria-label={`영상에서 빼기: ${i.text}`} disabled={busy} onClick={() => void run(`ex:${i.id}`, { kind: 'EXCLUDE', itemId: i.id }, '이 내용을 뺀 영상을 다시 만들고 있습니다.')}>영상에서 빼기</button>
                    <button aria-label={`문장 고치기: ${i.text}`} disabled={busy} onClick={() => { setEditing(i.id); setDraft(i.text); }}>문장 고치기</button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {droppedItems.length > 0 && <p className="meta">이미 영상에 들어가지 않는 내용 {droppedItems.length}개</p>}
          <div className="voice-revise">
            <label htmlFor="voice-item">말로 고칠 내용</label>
            <select id="voice-item" value={voiceItem} onChange={(e) => setVoiceItem(e.target.value)}>
              <option value="">내용을 고르세요</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.text}</option>)}
            </select>
            <label htmlFor="voice-text">명령 (예: “이 부분은 영상에서 빼줘”)</label>
            <input id="voice-text" value={voice} maxLength={300} onChange={(e) => setVoice(e.target.value)} />
            <button aria-pressed={listening} onClick={listen}>{listening ? '듣는 중… 누르면 멈춤' : '말하기'}</button>
            <button data-testid="voice-send" disabled={busy || !voice.trim() || !voiceItem} onClick={() => void run(`voice:${voiceItem}:${voice}`, { kind: 'VOICE', itemId: voiceItem, command: voice }, '이번 영상에서만 뺀 영상을 다시 만들고 있습니다.')}>명령 보내기</button>
          </div>
        </details>
      )}

      <h4>결과 버전</h4>
      {versions?.state === 'ok' && (versions.data.versions.length === 0
        ? <p data-testid="versions-empty">아직 만들어진 결과 영상이 없습니다.</p>
        : <ul data-testid="result-versions">
          {versions.data.versions.map((v) => (
            <li key={v.version} data-role={v.role} data-status={v.status}>
              버전 {v.version} · <span data-testid="version-label">{versionLabel(v)}</span>
              {v.downloadable && <> · <a href={resultFileUrl(d.id, v.version, false)} download>내려받기</a></>}
              {!v.fileAvailable && ' · 파일 없음'}
            </li>
          ))}
        </ul>)}
      {versions && versions.state !== 'ok' && <p role="alert">결과 버전을 불러오지 못했습니다.</p>}
    </section>
  );
}
