import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { postRevision, resultProblem, type DisplayStatus, type RecordDetail, type ResultVersion } from './records';
import { ResultPanel } from './ResultPanel';

const ID = '11111111-1111-4111-8111-111111111111';
const detail = (status: DisplayStatus, extra: Partial<RecordDetail> = {}): RecordDetail => ({
  id: ID, lifeDate: '2026-10-20', status, pipeline: { production: 'DONE', review: 'PASSED', backup: 'NONE' },
  nextActions: status === 'COMPLETED' ? ['DOWNLOAD'] : [], conversation: [], summary: null, attachments: [],
  result: { version: 2, fileAvailable: status === 'COMPLETED' }, revisableItems: [{ id: 'i1', text: '에코 버그를 고쳤다' }], ...extra,
});
const v = (version: number, state: ResultVersion['state'], downloadable: boolean): ResultVersion => ({ version, state, downloadable, playable: downloadable, fileAvailable: true, createdAt: '2026-10-20T00:00:00Z' });
const html = (d: RecordDetail, versions: ResultVersion[] | null, withRevise = true) => renderToStaticMarkup(<ResultPanel d={d} versions={versions} onRevise={withRevise ? () => {} : undefined} />);

describe('ResultPanel', () => {
  it('AC-1 정상 완료: 재생 요소와 내려받기 링크가 현재 완성본 버전을 가리킨다', () => {
    const out = html(detail('COMPLETED'), [v(2, 'CURRENT', true), v(1, 'PREVIOUS', true)]);
    expect(out).toContain('<video');
    expect(out).toContain(`src="/api/records/${ID}/results/2/file"`);
    expect(out).toContain(`href="/api/records/${ID}/results/2/file?download=1"`);
    expect(out).toContain('data-testid="download-result"');
    expect(out).not.toContain('result-problem');
  });

  it('AC-5 이전 버전은 현재 완성본이 아닌 이전 버전으로만 표시되고 재생 요소가 되지 않는다', () => {
    const out = html(detail('COMPLETED'), [v(2, 'CURRENT', true), v(1, 'PREVIOUS', true)]);
    expect(out).toContain('이전 버전(현재 완성본 아님)');
    expect(out.match(/<video/g)).toHaveLength(1);
    // 수정 제작 중: 최신 결과가 대체되면 영상 요소 없이 제작 중 안내만.
    const producing = html(detail('PRODUCING', { result: { version: 1, fileAvailable: false, superseded: true } }), [v(1, 'PREVIOUS', true)]);
    expect(producing).not.toContain('<video');
    expect(producing).not.toContain('data-testid="download-result"');
    expect(producing).toContain('이전 버전으로만 표시');
    expect(producing).toContain('이전 버전(현재 완성본 아님)');
  });

  it('AC-3 파일이 없으면 실패 이유와 가능한 조치를 보여주고 영상 요소가 없다', () => {
    const out = html(detail('RESULT_FILE_MISSING', { result: { version: 1, fileAvailable: false } }), [v(1, 'NOT_PASSED', false)]);
    expect(out).toContain('결과 파일을 찾을 수 없어');
    expect(out).toContain('data-testid="result-actions"');
    expect(out).toContain('다시 만들기');
    expect(out).not.toContain('<video');
  });

  it('미통과·실패·예산 대기·검수 중은 각각 다른 이유를 보여주고 영상을 만들지 않는다', () => {
    const statuses: DisplayStatus[] = ['REVIEW_REJECTED', 'FAILED', 'BUDGET_WAIT', 'REVIEW_PENDING'];
    const reasons = statuses.map((s) => resultProblem(s, false)!.reason);
    expect(new Set(reasons).size).toBe(statuses.length);
    for (const s of statuses) {
      const out = html(detail(s), [v(1, 'NOT_PASSED', false)]);
      expect(out).toContain('data-testid="result-problem"');
      expect(out).not.toContain('<video');
      expect(out).not.toContain('download-result');
    }
  });

  it('AC-4 확인 전 기록은 영상 대신 확인 전 안내만 보인다', () => {
    const out = html(detail('WRITING', { result: null, nextActions: ['CONTINUE_RECORDING'] }), null);
    expect(out).toContain('result-unconfirmed');
    expect(out).not.toContain('<video');
    expect(out).not.toContain('result-revise');
  });

  it('수정 요청 버튼: 완료·미통과에는 항목별 빼기/고치기, 실패에는 다시 시도, 처리 중에는 없음', () => {
    expect(html(detail('COMPLETED'), [v(2, 'CURRENT', true)])).toContain('영상에서 빼기: 에코 버그를 고쳤다');
    expect(html(detail('REVIEW_REJECTED', { nextActions: ['EDIT_AND_REMAKE'] }), [v(1, 'NOT_PASSED', false)])).toContain('고치기');
    const failed = html(detail('FAILED', { nextActions: ['RETRY'], result: null }), []);
    expect(failed).toContain('다시 시도');
    expect(failed).not.toContain('revise-items');
    const producing = html(detail('PRODUCING', { nextActions: ['WAIT'] }), []);
    expect(producing).not.toContain('영상에서 빼기');
    expect(producing).not.toContain('다시 시도');
  });
});

describe('postRevision', () => {
  const res = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('실행됨·미실행(삭제 명령 등)·거부·네트워크 오류를 구분해 안내하고 commandId 를 함께 보낸다', async () => {
    let sent = '';
    const spy = (async (_u: string, init: RequestInit) => { sent = String(init.body); return new Response(JSON.stringify({ executed: true }), { status: 200 }); }) as unknown as typeof fetch;
    const ok = await postRevision(ID, { type: 'EXCLUDE', itemId: 'i1' }, 'cmd-1', spy);
    expect(ok).toMatchObject({ ok: true, executed: true });
    expect(JSON.parse(sent)).toEqual({ type: 'EXCLUDE', itemId: 'i1', commandId: 'cmd-1' });
    expect(await postRevision(ID, { type: 'VOICE', text: '삭제해' }, 'c', res(200, { executed: false, message: '원본 삭제는 영상 제외와 별개입니다.' }))).toMatchObject({ ok: true, executed: false, message: '원본 삭제는 영상 제외와 별개입니다.' });
    expect(await postRevision(ID, { type: 'RETRY' }, 'c', res(409, { message: '진행 중' }))).toMatchObject({ ok: false, executed: false, message: '진행 중' });
    expect(await postRevision(ID, { type: 'RETRY' }, 'c', res(401, {}))).toMatchObject({ ok: false });
    expect(await postRevision(ID, { type: 'RETRY' }, 'c', (async () => { throw new TypeError('x'); }) as never)).toMatchObject({ ok: false, executed: false });
  });
});
