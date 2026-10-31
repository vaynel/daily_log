import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmBox } from './TrashView';
import { QUALITY_REASON_LABEL, SCOPE_NOTICE, cleanupReasonLabel, commandError, postCommand, ACTION_LABEL, byLifeDate, coversMonth, fetchJson, initialMonth, recordsUrl, monthGrid, shiftMonth, PIPELINE_LABEL, STATUS_INFO, type DisplayStatus, type Loaded, type RecordDetail, type RecordRow, type RecordsPage } from './records';

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

export type RecordsMode = 'list' | 'calendar';

/** 기록 목록을 한 번 불러와 최신순 목록과 달력이 같은 데이터를 쓴다. 보기 방식은 상위가 유지한다. */
export function RecordsBrowser({ mode, onMode, month, onMonth, onOpen }: { mode: RecordsMode; onMode: (m: RecordsMode) => void; month: string | null; onMonth: (ym: string) => void; onOpen: (id: string) => void }) {
  const [r, setR] = useState<Loaded<RecordsPage> | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const load = useCallback(() => { setR(null); setMore('idle'); void fetchJson<RecordsPage>(recordsUrl(null)).then(setR); }, []);
  useEffect(load, [load]);
  const data = r?.state === 'ok' ? r.data : null;
  const cursor = data?.nextCursor ?? null;
  // 다음 페이지를 이어 붙인다. 목록 순서(생활일 내림차순)는 서버가 정하고 id 로 중복을 거른다.
  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setMore('loading');
    const next = await fetchJson<RecordsPage>(recordsUrl(cursor));
    if (next.state !== 'ok') { setMore('error'); return; }
    setR((prev) => {
      if (prev?.state !== 'ok') return prev;
      const seen = new Set(prev.data.records.map((x) => x.id));
      return { state: 'ok', data: { records: [...prev.data.records, ...next.data.records.filter((x) => !seen.has(x.id))], nextCursor: next.data.nextCursor } };
    });
    setMore('idle');
  }, [cursor]);
  // 달력은 보고 있는 달의 첫날까지 자동으로 이어 불러와, 아직 못 불러온 날짜를 "기록 없음"으로 잘못 보이지 않게 한다.
  const calYm = data ? (month ?? initialMonth(data.records)) : null;
  const needMore = mode === 'calendar' && !!data && !!calYm && !coversMonth(data.records, data.nextCursor, calYm);
  useEffect(() => { if (needMore && more === 'idle') void loadMore(); }, [needMore, more, loadMore]);
  if (!r) return <p>기록을 불러오는 중</p>;
  if (r.state !== 'ok') return <Problem r={r} onRetry={load} />;
  return (
    <>
      <div role="group" aria-label="보기 방식" className="modes">
        <button aria-pressed={mode === 'list'} data-testid="mode-list" onClick={() => onMode('list')}>목록</button>
        <button aria-pressed={mode === 'calendar'} data-testid="mode-calendar" onClick={() => onMode('calendar')}>달력</button>
      </div>
      {mode === 'list' ? <RecordRows rows={r.data.records} onOpen={onOpen} /> : <RecordsCalendar rows={r.data.records} month={month} onMonth={onMonth} onOpen={onOpen} />}
      {more === 'error' && <p role="alert" data-testid="more-error">이전 기록을 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.</p>}
      {r.data.nextCursor && (
        <button data-testid="load-more" disabled={more === 'loading'} onClick={() => void loadMore()}>
          {more === 'loading' ? '불러오는 중' : more === 'error' ? '다시 시도' : '이전 기록 더 보기'}
        </button>
      )}
    </>
  );
}

/** 생활일 최신순 목록. 정렬은 서버가 생활일 기준으로 한다. */
function RecordRows({ rows, onOpen }: { rows: RecordRow[]; onOpen: (id: string) => void }) {
  if (rows.length === 0) return <p data-testid="records-empty">아직 기록이 없습니다.</p>;
  return (
    <ul className="records" data-testid="records-list" aria-label="생활일별 기록">
      {rows.map((x) => (
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

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * 생활일 달력. 서버가 준 목록에 있는 날짜만 기록으로 연결한다.
 * 기록 없는 날짜는 안내만 보이고 어떤 요청도 보내지 않는다(과거 기록 자동 생성 금지).
 */
function RecordsCalendar({ rows, month, onMonth, onOpen }: { rows: RecordRow[]; month: string | null; onMonth: (ym: string) => void; onOpen: (id: string) => void }) {
  const byDate = useMemo(() => byLifeDate(rows), [rows]);
  const ym = month ?? initialMonth(rows);
  const [emptyDate, setEmptyDate] = useState<string | null>(null);
  const move = (d: number) => { onMonth(shiftMonth(ym, d)); setEmptyDate(null); };
  return (
    <div data-testid="records-calendar">
      <div className="cal-nav">
        <button onClick={() => move(-1)} aria-label="이전 달" data-testid="cal-prev">‹</button>
        <strong data-testid="cal-month" aria-live="polite">{ym.slice(0, 4)}년 {Number(ym.slice(5))}월</strong>
        <button onClick={() => move(1)} aria-label="다음 달" data-testid="cal-next">›</button>
      </div>
      <table className="cal">
        <thead><tr>{WEEKDAYS.map((w) => <th key={w} scope="col">{w}</th>)}</tr></thead>
        <tbody>
          {monthGrid(ym).map((week, i) => (
            <tr key={i}>
              {week.map((c, j) => {
                if (!c.date) return <td key={j} />;
                const rec = byDate.get(c.date);
                const label = rec ? `${c.date} ${STATUS_INFO[rec.status].label}` : `${c.date} 기록 없음`;
                return (
                  <td key={j} data-date={c.date} data-has-record={rec ? 'true' : 'false'}>
                    <button className={`day${rec ? ` has ${STATUS_INFO[rec.status].tone}` : ''}`} aria-label={label}
                      onClick={() => (rec ? onOpen(rec.id) : setEmptyDate(c.date))}>
                      <span>{c.day}</span>
                      {rec && <small data-testid="status-badge" data-status={rec.status}>{STATUS_INFO[rec.status].label}</small>}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {emptyDate && <p role="status" data-testid="cal-empty-day">{emptyDate}에는 기록이 없습니다.</p>}
    </div>
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
      {r?.state === 'ok' && <Detail d={r.data} onChanged={load} onDeletedRecord={onBack} />}
    </section>
  );
}

type Pending = { url: string; title: string; wholeRecord: boolean };

/** 휴지통으로 보내는 삭제 확인. 되돌릴 수 있고(30일) 서버 사본만 대상이라는 점을 먼저 알린다. */
function TrashConfirm({ p, busy, onYes, onNo }: { p: Pending; busy: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <ConfirmBox title={p.title} confirmLabel="휴지통으로 보내기" busy={busy} onConfirm={onYes} onCancel={onNo}>
      <p data-testid="trash-warning">삭제한 날부터 30일 안에는 휴지통에서 복구할 수 있습니다. {SCOPE_NOTICE}</p>
    </ConfirmBox>
  );
}

function Detail({ d, onChanged, onDeletedRecord }: { d: RecordDetail; onChanged: () => void; onDeletedRecord: () => void }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    const res = await postCommand(pending.url);
    setBusy(false);
    if (!res.ok) { setErr(commandError(res.code)); setPending(null); return; }
    setErr(null);
    setPending(null);
    if (pending.wholeRecord) onDeletedRecord(); else onChanged();
  };
  const ask = (url: string, title: string, wholeRecord = false) => setPending({ url, title, wholeRecord });
  const info = STATUS_INFO[d.status];
  const att = (aid: string) => d.attachments.find((a) => a.id === aid);
  const link = (a: RecordDetail['attachments'][number]) => (
    <a href={`/api/records/${d.id}/attachments/${a.id}/file`} download>{a.name ?? '첨부'} ({size(a.size)})</a>
  );
  return (
    <>
      <h3>{d.lifeDate} <Badge status={d.status} /></h3>
      <p data-testid="status-hint">{info.hint}</p>
      {d.serverCopy?.cleanedAt && <p role="status" data-testid="server-cleaned">한 달이 지나 서버 사본은 정리되었습니다. Google Drive 백업과 완성 영상은 그대로 보관됩니다.</p>}
      {!d.serverCopy?.cleanedAt && d.serverCopy?.cleanupBlockedReason && <p role="status" data-testid="cleanup-pending">서버 사본 정리 대기: {cleanupReasonLabel(d.serverCopy.cleanupBlockedReason)}. 서버 원본은 유지됩니다.</p>}
      {err && <p role="alert" data-testid="command-error">{err}</p>}
      {pending && <TrashConfirm p={pending} busy={busy} onYes={() => void confirm()} onNo={() => setPending(null)} />}
      {!d.serverCopy?.cleanedAt && <p><button data-testid="trash-record" onClick={() => ask(`/api/records/${d.id}/trash`, `${d.lifeDate} 하루 기록을 휴지통으로 보낼까요?`, true)}>이 날 기록 삭제</button></p>}
      {!!d.pipeline.qualityReasons?.length && <ul data-testid="quality-reasons" role="status">
        {d.pipeline.qualityReasons.map(reason => <li key={reason}>{QUALITY_REASON_LABEL[reason] ?? '제작 조건을 확인해 주세요.'}</li>)}
      </ul>}
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
              <span className="who">{c.kind === 'QUESTION' ? '질문' : '내 답'}</span> {c.body}{' '}
              <button data-testid="trash-item" aria-label={`${c.kind === 'QUESTION' ? '질문' : '내 답'} ${c.seq}번 삭제`} onClick={() => ask(`/api/records/${d.id}/items/${c.id}/trash`, `${c.kind === 'QUESTION' ? '질문' : '내 답'} ${c.seq}번을 휴지통으로 보낼까요? 연결된 첨부도 함께 옮겨집니다.`)}>삭제</button>
              {c.attachmentIds.map((aid) => { const a = att(aid); return a ? <div key={aid}>첨부: {link(a)}</div> : null; })}
            </li>
          ))}
        </ol>
      )}
      {(() => {
        const loose = d.attachments.filter((a) => !a.itemId);
        return loose.length ? <><h4>첨부</h4><ul data-testid="attachments">{loose.map((a) => <li key={a.id}>{link(a)}{' '}<button data-testid="trash-attachment" aria-label={`첨부 ${a.name ?? ''} 삭제`} onClick={() => ask(`/api/records/${d.id}/attachments/${a.id}/trash`, `첨부 ${a.name ?? ''}를 휴지통으로 보낼까요?`)}>삭제</button></li>)}</ul></> : null;
      })()}
    </>
  );
}
