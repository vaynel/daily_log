import { useState } from 'react';
import { RESULT_STATE_LABEL, resultFileUrl, resultProblem, type RecordDetail, type RevisionRequest, type ResultVersion } from './records';

export interface ResultPanelProps {
  d: RecordDetail;
  versions: ResultVersion[] | null;
  /** 수정 요청 결과 안내문(성공·실패). 없으면 표시하지 않는다. */
  notice?: { ok: boolean; text: string } | null;
  busy?: boolean;
  onRevise?: (r: RevisionRequest) => void;
}

/** 결과 영상 확인·재생·내려받기와 수정 요청. 정상 완료가 아니면 영상 요소를 만들지 않고 이유와 가능한 조치를 보여준다. */
export function ResultPanel({ d, versions, notice, busy, onRevise }: ResultPanelProps) {
  const [text, setText] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const problem = resultProblem(d.status, d.result?.fileAvailable);
  // 현재 완성본은 상세 응답(서버가 같은 판정으로 COMPLETED·파일 있음을 확인)으로 바로 정한다. 버전 목록은 이전 결과 표시용이다.
  const currentVersion = d.status === 'COMPLETED' && d.result && !d.result.superseded && d.result.fileAvailable ? d.result.version : null;
  const current = currentVersion === null ? null : { version: currentVersion };
  const previous = (versions ?? []).filter((v) => v.state !== 'CURRENT' && v.version !== currentVersion);
  const confirmed = d.status !== 'WRITING';
  const canRevise = !!onRevise && !busy && (d.nextActions.includes('DOWNLOAD') || d.nextActions.includes('EDIT_AND_REMAKE'));
  const canRetry = !!onRevise && !busy && d.nextActions.includes('RETRY');
  const items = d.revisableItems ?? [];

  return (
    <section aria-labelledby="result-heading" data-testid="result-panel">
      <h4 id="result-heading">결과 영상</h4>
      {!confirmed && <p data-testid="result-unconfirmed">아직 확인하지 않은 기록입니다. 확인 전에는 영상이 만들어지거나 공개되지 않습니다.</p>}
      {confirmed && !problem && current && (
        <>
          <video data-testid="result-video" controls playsInline preload="metadata" src={resultFileUrl(d.id, current.version)} aria-label={`${d.lifeDate} 결과 영상`} style={{ width: '100%', maxWidth: 360, aspectRatio: '9 / 16', background: '#000' }}>
            이 브라우저에서는 영상을 재생할 수 없습니다. 아래 내려받기로 확인해 주세요.
          </video>
          <p><a className="button" data-testid="download-result" href={resultFileUrl(d.id, current.version, true)} download>영상 내려받기</a></p>
        </>
      )}
      {confirmed && problem && (
        <div role="alert" data-testid="result-problem">
          <p><strong>{problem.reason}</strong></p>
          {!!problem.actions.length && <ul data-testid="result-actions">{problem.actions.map((a) => <li key={a}>{a}</li>)}</ul>}
        </div>
      )}

      {!!previous.length && (
        <div data-testid="result-versions">
          <h5>이전 결과</h5>
          <ul>
            {previous.map((v) => (
              <li key={v.version} data-state={v.state}>
                v{v.version} · {RESULT_STATE_LABEL[v.state]}
                {v.downloadable && v.fileAvailable && <> · <a href={resultFileUrl(d.id, v.version, true)} download>내려받기</a></>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {onRevise && confirmed && (
        <div data-testid="result-revise">
          <h5>수정해서 다시 만들기</h5>
          {notice && <p role={notice.ok ? 'status' : 'alert'} data-testid="revise-notice">{notice.text}</p>}
          {canRetry && <p><button disabled={busy} onClick={() => onRevise({ type: 'RETRY' })}>다시 시도</button></p>}
          {canRevise && !items.length && <p>수정할 수 있는 항목이 없습니다.</p>}
          {canRevise && !!items.length && (
            <ul data-testid="revise-items">
              {items.map((i) => (
                <li key={i.id}>
                  <span>{i.text}</span>{' '}
                  <button disabled={busy} onClick={() => onRevise({ type: 'EXCLUDE', itemId: i.id })} aria-label={`영상에서 빼기: ${i.text}`}>영상에서 빼기</button>{' '}
                  <button disabled={busy} onClick={() => { setEditId(i.id); setText(i.text); }} aria-label={`문장 고치기: ${i.text}`}>고치기</button>
                </li>
              ))}
            </ul>
          )}
          {canRevise && editId && (
            <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onRevise({ type: 'EDIT_TEXT', itemId: editId, text }); setEditId(null); } }}>
              <label>바꿀 문장 <input value={text} maxLength={300} onChange={(e) => setText(e.target.value)} /></label>{' '}
              <button type="submit" disabled={busy || !text.trim()}>고쳐서 다시 만들기</button>{' '}
              <button type="button" onClick={() => setEditId(null)}>취소</button>
            </form>
          )}
          {canRevise && (
            <form onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('voice') ?? '').trim(); if (v) onRevise({ type: 'VOICE', text: v }); }}>
              <label>말로 수정(음성 인식 결과 또는 입력) <input name="voice" maxLength={300} placeholder={'예: "회의" 부분은 빼 줘'} /></label>{' '}
              <button type="submit" disabled={busy}>수정 요청</button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
