import { useCallback, useEffect, useState } from 'react';
import { ACTION_LABEL, fetchJson, PIPELINE_LABEL, STATUS_INFO, type DisplayStatus, type Loaded, type RecordDetail, type RecordRow } from './records';

function Badge({ status }: { status: DisplayStatus }) {
  const s = STATUS_INFO[status];
  return <span className={`badge ${s.tone}`} data-testid="status-badge" data-status={status}>{s.label}</span>;
}

function Problem({ r, onRetry }: { r: Exclude<Loaded<unknown>, { state: 'ok' }>; onRetry: () => void }) {
  if (r.state === 'expired') return <div role="alert" data-testid="screen-access-expired"><p>접근이 만료되었습니다. 다시 로그인해 주세요.</p><a className="button" href="/auth/login">Google로 다시 로그인</a></div>;
  if (r.state === 'not-found') return <div role="alert" data-testid="screen-not-found"><p>기록을 찾을 수 없거나 볼 수 있는 권한이 없습니다.</p></div>;
  return <div role="alert" data-testid="screen-load-error"><p>불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.</p><button onClick={onRetry}>다시 불러오기</button></div>;
}

const size = (n: number | null) => (n === null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** 생활일 최신순 목록. 정렬은 서버가 생활일 기준으로 한다. */
export function RecordsList({ onOpen }: { onOpen: (id: string) => void }) {
  const [r, setR] = useState<Loaded<{ records: RecordRow[] }> | null>(null);
  const load = useCallback(() => { setR(null); void fetchJson<{ records: RecordRow[] }>('/api/records').then(setR); }, []);
  useEffect(load, [load]);
  if (!r) return <p>기록을 불러오는 중</p>;
  if (r.state !== 'ok') return <Problem r={r} onRetry={load} />;
  if (r.data.records.length === 0) return <p data-testid="records-empty">아직 기록이 없습니다.</p>;
  return (
    <ul className="records" data-testid="records-list" aria-label="생활일별 기록">
      {r.data.records.map((x) => (
        <li key={x.id} data-life-date={x.lifeDate}>
          <button className="row" onClick={() => onOpen(x.id)}>
            <strong>{x.lifeDate}</strong> <Badge status={x.status} />
            {x.attachmentCount > 0 && <span> · 첨부 {x.attachmentCount}개</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function RecordDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [r, setR] = useState<Loaded<RecordDetail> | null>(null);
  const load = useCallback(() => { setR(null); void fetchJson<RecordDetail>(`/api/records/${id}`).then(setR); }, [id]);
  useEffect(load, [load]);
  return (
    <section data-testid="screen-record-detail">
      <button onClick={onBack}>← 목록</button>
      {!r && <p>불러오는 중</p>}
      {r && r.state !== 'ok' && <Problem r={r} onRetry={load} />}
      {r?.state === 'ok' && <Detail d={r.data} />}
    </section>
  );
}

function Detail({ d }: { d: RecordDetail }) {
  const info = STATUS_INFO[d.status];
  const att = (aid: string) => d.attachments.find((a) => a.id === aid);
  const link = (a: RecordDetail['attachments'][number]) => (
    <a href={`/api/records/${d.id}/attachments/${a.id}/file`} download>{a.name ?? '첨부'} ({size(a.size)})</a>
  );
  return (
    <>
      <h3>{d.lifeDate} <Badge status={d.status} /></h3>
      <p data-testid="status-hint">{info.hint}</p>
      <dl data-testid="pipeline">
        <dt>제작</dt><dd>{PIPELINE_LABEL.production[d.pipeline.production]}</dd>
        <dt>검수</dt><dd>{PIPELINE_LABEL.review[d.pipeline.review]}</dd>
        <dt>백업</dt><dd>{PIPELINE_LABEL.backup[d.pipeline.backup]}</dd>
      </dl>
      <p data-testid="next-actions">
        가능한 다음 행동: {d.nextActions.length ? d.nextActions.map((a) => ACTION_LABEL[a]).join(' / ') : '없음'}
      </p>
      {d.result && (d.result.fileAvailable
        ? <p><a className="button" data-testid="download-result" href={`/api/records/${d.id}/result/file`} download>영상 내려받기</a></p>
        : <p role="alert" data-testid="result-file-missing">결과 파일을 찾을 수 없어 내려받을 수 없습니다.</p>)}

      <h4>정리된 일기</h4>
      {d.summary?.diary ? <p data-testid="diary">{d.summary.diary}</p> : <p>아직 정리된 일기가 없습니다.</p>}
      {!!d.summary?.learning.length && <><h4>학습 내용</h4><ul data-testid="learning">{d.summary.learning.map((l, i) => <li key={i}>{l}</li>)}</ul></>}

      <h4>대화 원본</h4>
      {d.conversation.length === 0 ? <p data-testid="conversation-empty">저장된 대화가 없습니다.</p> : (
        <ol data-testid="conversation">
          {d.conversation.map((c) => (
            <li key={c.id}>
              <span className="who">{c.kind === 'QUESTION' ? '질문' : '내 답'}</span> {c.body}
              {c.attachmentIds.map((aid) => { const a = att(aid); return a ? <div key={aid}>첨부: {link(a)}</div> : null; })}
            </li>
          ))}
        </ol>
      )}
      {(() => {
        const loose = d.attachments.filter((a) => !a.itemId);
        return loose.length ? <><h4>첨부</h4><ul data-testid="attachments">{loose.map((a) => <li key={a.id}>{link(a)}</li>)}</ul></> : null;
      })()}
    </>
  );
}
