import { useCallback, useEffect, useRef, useState } from 'react';
import { describeCapture, uploadAttachment, type AttachKind, type UploadItem } from './attach';

type Source = { kind: AttachKind; name: string; body: Blob | string };
const newKey = () => `ui-${crypto.randomUUID()}`;

const KIND_LABEL: Record<AttachKind, string> = { PHOTO: '사진', MARKDOWN: 'Markdown', NOTE: '학습 메모' };

/**
 * 대화 중 자료 첨부. 사진첩·카메라·파일(Markdown)·학습 메모 입력.
 * 항목은 서버가 저장을 확인한 뒤에만 "첨부됨"으로 바뀐다. 실패·중단은 사유와 "다시 시도"를 보여준다.
 */
export function AttachPanel() {
  const [recordId, setRecordId] = useState<string | null>(null);
  const [recordError, setRecordError] = useState(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [note, setNote] = useState('');
  const sources = useRef(new Map<string, Source>());
  const aborts = useRef(new Map<string, AbortController>());

  useEffect(() => {
    fetch('/api/records', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j: { id: string }) => setRecordId(j.id))
      .catch(() => setRecordError(true));
  }, []);

  const patch = (id: string, p: Partial<UploadItem>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const run = useCallback(async (item: UploadItem) => {
    if (!recordId) return;
    const src = sources.current.get(item.id)!;
    const ctl = new AbortController();
    aborts.current.set(item.id, ctl);
    patch(item.id, { status: 'uploading', message: undefined });
    const r = await uploadAttachment({ recordId, kind: src.kind, key: item.key, name: src.name, body: src.body, signal: ctl.signal });
    aborts.current.delete(item.id);
    patch(item.id, { status: r.status, message: r.message, retryable: r.retryable, duplicate: r.duplicate, capturedAt: r.capturedAt, capturedSource: r.capturedSource });
    if (r.ok) sources.current.delete(item.id);
  }, [recordId]);

  const add = useCallback((list: Source[]) => {
    const created = list.map((s): UploadItem => ({ id: crypto.randomUUID(), kind: s.kind, name: s.name, key: newKey(), status: 'uploading' }));
    created.forEach((c, i) => sources.current.set(c.id, list[i]!));
    setItems((xs) => [...xs, ...created]);
    created.forEach((c) => void run(c));
  }, [run]);

  const onFiles = (kind: AttachKind) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 같은 파일을 다시 고를 수 있게 비운다
    if (files.length) add(files.map((f) => ({ kind, name: f.name || (kind === 'PHOTO' ? 'camera.jpg' : 'file.md'), body: f })));
  };

  const saveNote = () => {
    if (!note.trim()) return;
    add([{ kind: 'NOTE', name: 'note.md', body: note }]);
    setNote('');
  };

  const disabled = !recordId;
  return (
    <section data-testid="attach-panel" aria-labelledby="attach-h" className="attach">
      <h3 id="attach-h">자료 첨부</h3>
      {recordError && <p role="alert">기록을 열지 못했습니다. 새로고침 후 다시 시도해 주세요.</p>}
      <div className="attach-actions">
        <label className="button secondary">사진첩<input data-testid="in-gallery" type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple disabled={disabled} onChange={onFiles('PHOTO')} className="visually-hidden" /></label>
        <label className="button secondary">카메라<input data-testid="in-camera" type="file" accept="image/*" capture="environment" disabled={disabled} onChange={onFiles('PHOTO')} className="visually-hidden" /></label>
        <label className="button secondary">Markdown 파일<input data-testid="in-file" type="file" accept=".md,.markdown,text/markdown" multiple disabled={disabled} onChange={onFiles('MARKDOWN')} className="visually-hidden" /></label>
      </div>
      <label htmlFor="note-text">학습 메모</label>
      <textarea id="note-text" data-testid="note-text" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="오늘 배운 것을 짧게 적어 붙일 수 있습니다 (선택)" style={{ width: '100%', boxSizing: 'border-box' }} />
      <button data-testid="note-save" onClick={saveNote} disabled={disabled || !note.trim()}>메모 붙이기</button>
      <ul data-testid="attach-list" aria-live="polite" className="attach-list">
        {items.map((it) => (
          <li key={it.id} data-testid="attach-item" data-status={it.status}>
            <strong>{it.name}</strong> <span>({KIND_LABEL[it.kind]})</span>{' '}
            {it.status === 'uploading' && <><span>올리는 중…</span> <button onClick={() => aborts.current.get(it.id)?.abort()}>중단</button></>}
            {it.status === 'done' && <span>{it.duplicate ? '이미 첨부된 파일입니다 (중복 저장 안 함)' : '첨부됨'}{it.kind === 'PHOTO' && <> · {describeCapture(it.capturedAt, it.capturedSource)}</>}</span>}
            {(it.status === 'failed' || it.status === 'canceled') && (
              <>
                <span role="alert">{it.message}</span>{' '}
                {it.retryable ? <button onClick={() => void run(it)}>다시 시도</button> : <button onClick={() => { setItems((xs) => xs.filter((x) => x.id !== it.id)); sources.current.delete(it.id); }}>목록에서 지우기</button>}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
