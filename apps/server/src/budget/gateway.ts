import { TransportError } from '../voice/transports.js';
import type { MonthlyLedger, Purpose } from './ledger.js';

/**
 * 유료 외부 호출 경계. 모든 유료 호출(STT·TTS·이미지·Live 턴)은 예약 → 호출 → 확정/보존 순서로만 실행한다.
 * 오류에는 키·본문·개인 원문을 담지 않고 코드만 남긴다.
 */
export type FailureClass = 'REJECTED' | 'UNKNOWN';

/**
 * 호출 실패 분류.
 * - REJECTED: 제공자가 4xx 로 명시 거절(과금 없음이 확실) → 예약 해제.
 * - UNKNOWN: 네트워크 오류·시간 초과·5xx 등 성공 여부 불명 → 예약액 유지(환급 금지).
 */
export function classifyFailure(e: unknown): FailureClass {
  if (e instanceof TransportError) {
    const m = /_HTTP_(\d{3})$/.exec(e.code);
    if (m && Number(m[1]) >= 400 && Number(m[1]) < 500) return 'REJECTED';
  }
  return 'UNKNOWN';
}

export interface PaidCall<T> {
  ledger: MonthlyLedger;
  provider: string;
  operation: string;
  purpose: Purpose;
  estimateKrw: number;
  idempotencyKey?: string;
  run: () => Promise<T>;
  /** 성공 결과로부터 실제(추정) 비용을 계산. 생략하면 예상액. */
  actualKrw?: (r: T) => number;
}

export type PaidResult<T> =
  | { ok: true; value: T; entryId: string; actualKrw: number }
  | { ok: false; code: 'BUDGET_EXCEEDED' }
  | { ok: false; code: 'CALL_REJECTED' | 'CALL_UNKNOWN'; entryId: string };

export async function paidCall<T>(c: PaidCall<T>): Promise<PaidResult<T>> {
  const res = await c.ledger.reserve({
    provider: c.provider, operation: c.operation, purpose: c.purpose, estimateKrw: c.estimateKrw, idempotencyKey: c.idempotencyKey,
  });
  // 예약 실패 시 run 은 호출되지 않는다.
  if (!res.ok) return { ok: false, code: 'BUDGET_EXCEEDED' };
  if (res.duplicate) return { ok: false, code: 'CALL_UNKNOWN', entryId: res.id };
  let value: T;
  try {
    value = await c.run();
  } catch (e) {
    if (classifyFailure(e) === 'REJECTED') {
      await c.ledger.releaseUnsent(res.id);
      return { ok: false, code: 'CALL_REJECTED', entryId: res.id };
    }
    await c.ledger.markUnknown(res.id, e instanceof TransportError ? e.code : 'CALL_ERROR');
    return { ok: false, code: 'CALL_UNKNOWN', entryId: res.id };
  }
  const actual = c.actualKrw ? c.actualKrw(value) : c.estimateKrw;
  await c.ledger.confirm(res.id, actual);
  return { ok: true, value, entryId: res.id, actualKrw: actual };
}
