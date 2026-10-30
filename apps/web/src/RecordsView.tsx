import { useCallback, useEffect, useMemo, useState } from 'react';
import { BACKUP_KEPT_TEXT, QUALITY_REASON_LABEL, ACTION_LABEL, commandErrorText, postJson, byLifeDate, coversMonth, fetchJson, initialMonth, recordsUrl, monthGrid, shiftMonth, PIPELINE_LABEL, STATUS_INFO, type DisplayStatus, type Loaded, type RecordDetail, type RecordRow, type RecordsPage } from './records';

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
  // 항목·첨부 삭제 뒤에는 화면을 비우지 않고 조용히 다시 불러와 완료 안내가 사라지지 않게 한다.
  const refresh = useCallback(() => { void fetchJson<RecordDetail>(`/api/records/${id}`).then(setR); }, [id]);
  return (
    <section data-testid="screen-record-detail">
      <button onClick={onBack}>← 목록</button>
      {!r && <p>불러오는 중</p>}
      {r && r.state !== 'ok' && <Problem r={r} onRetry={load} />}
      {r?.state === 'ok' && <Detail d={r.data} onChanged={refresh} onTrashed={onBack} />}
    </section>
  );
}

/** 삭제 명령 버튼. 한 번 누르면 결과를 알리는 확인 단계가 나오고, 확인해야 휴지통으로 옮긴다(실수 방지). */
function TrashButton({ label, what, url, onDone }: { label: string; what: string; url: string; onDone: (text: string) => void }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    const res = await postJson(url);
    setBusy(false);
    if (res.ok) { setAsk(false); onDone(`${what}을(를) 휴지통으로 옮겼습니다. 30일 안에 복구할 수 있습니다. ${BACKUP_KEPT_TEXT}`); } else setErr(commandErrorText(res.code));
  };
  if (!ask) return <button data-testid="trash-open" onClick={() => { setErr(null); setAsk(true); }}>{label}</button>;
  return (
    <span role="alertdialog" aria-label={`${what} 삭제 확인`} data-testid="trash-confirm">
      <span>{what}을(를) 휴지통으로 옮깁니다. 30일 안에는 복구할 수 있고, 그 뒤에는 이 앱 서버에서 삭제됩니다. {BACKUP_KEPT_TEXT}</span>
      <button disabled={busy} data-testid="trash-yes" onClick={() => void go()}>휴지통으로 옮기기</button>
      <button disabled={busy} data-testid="trash-no" onClick={() => setAsk(false)}>취소</button>
      {err && <span role="alert" data-testid="trash-error">{err}</span>}
    </span>
  );
}

function Detail({ d, onChanged, onTrashed }: { d: RecordDetail; onChanged: () => void; onTrashed: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const info = STATUS_INFO[d.status];
  const att = (aid: string) => d.attachments.find((a) => a.id === aid);
  const link = (a: RecordDetail['attachments'][number]) => (
    <>
      <a href={`/api/records/${d.id}/attachments/${a.id}/file`} download>{a.name ?? '첨부'} ({size(a.size)})</a>
      <TrashButton label="첨부 삭제" what={`첨부 ${a.name ?? ''}`.trim()} url={`/api/records/${d.id}/attachments/${a.id}/trash`} onDone={(t) => { setNote(t); onChanged(); }} />
    </>
  );
  return (
    <>
      <h3>{d.lifeDate} <Badge status={d.status} /></h3>
      {note && <p role="status" data-testid="trash-done">{note}</p>}
      {d.retention?.message && <p data-testid="retention-note" data-server-copy={d.retention.serverCopy}>{d.retention.message}</p>}
      <p data-testid="status-hint">{info.hint}</p>
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
              <span className="who">{c.kind === 'QUESTION' ? '질문' : '내 답'}</span> {c.body}
              {d.retention?.serverCopy !== 'CLEANED' && <TrashButton label="이 항목 삭제" what="이 대화 항목" url={`/api/records/${d.id}/items/${c.id}/trash`} onDone={(t) => { setNote(t); onChanged(); }} />}
              {c.attachmentIds.map((aid) => { const a = att(aid); return a ? <div key={aid}>첨부: {link(a)}</div> : null; })}
            </li>
          ))}
        </ol>
      )}
      {(() => {
        const loose = d.attachments.filter((a) => !a.itemId);
        return loose.length ? <><h4>첨부</h4><ul data-testid="attachments">{loose.map((a) => <li key={a.id}>{link(a)}</li>)}</ul></> : null;
      })()}

      <h4>기록 삭제</h4>
      <p>이 날의 기록 전체를 휴지통으로 옮깁니다. 서버 사본만 대상이며 {BACKUP_KEPT_TEXT}</p>
      <TrashButton label="이 날의 기록 삭제" what={`${d.lifeDate} 기록`} url={`/api/records/${d.id}/trash`} onDone={() => onTrashed()} />
    </>
  );
}
