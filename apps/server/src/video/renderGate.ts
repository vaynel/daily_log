import type pg from 'pg';

/** 렌더 동시 실행 제한용 advisory lock 키(프로세스가 여럿이어도 DB 하나를 공유하면 한 번에 하나). */
export const RENDER_LOCK_KEY = 25_000_001;

/**
 * 렌더를 한 번에 하나만 실행하게 하는 문. 같은 프로세스 안에서는 FIFO 대기열로, pool 이 있으면 PostgreSQL advisory lock 으로
 * 프로세스 사이에서도 직렬화한다. 대기 중인 요청은 거절하지 않고 차례를 기다린다.
 */
export class RenderGate {
  private tail: Promise<unknown> = Promise.resolve();
  private _active = 0;
  private _peak = 0;
  constructor(private readonly pool?: pg.Pool, private readonly lockKey = RENDER_LOCK_KEY) {}

  get active() { return this._active; }
  /** 지금까지 동시에 실행된 최대 개수(시험·운영 점검용). */
  get peak() { return this._peak; }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => this.exclusive(fn));
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const client = this.pool ? await this.pool.connect() : null;
    try {
      if (client) await client.query('SELECT pg_advisory_lock($1)', [this.lockKey]);
      this._active++;
      this._peak = Math.max(this._peak, this._active);
      try {
        return await fn();
      } finally {
        this._active--;
        if (client) await client.query('SELECT pg_advisory_unlock($1)', [this.lockKey]).catch(() => {});
      }
    } finally {
      client?.release();
    }
  }
}
