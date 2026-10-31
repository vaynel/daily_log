import type pg from 'pg';
import type { TokenVault } from './vault.js';

export type ConnectionState = 'NONE' | 'CONNECTED' | 'AUTH_EXPIRED';

/** 로그인 플러그인이 사용하는 Drive 연결 저장소 계약. */
export interface DriveConnectionStore {
  save(ownerId: string, email: string, refreshToken: string, scope: string): Promise<void>;
  state(ownerId: string): Promise<ConnectionState>;
  /** 토큰 행을 지우고(연결 해제) 철회용 평문 토큰을 한 번 돌려준다. 백업 항목·Drive 파일은 건드리지 않는다. */
  disconnect(ownerId: string): Promise<string | null>;
}

/** AAD 에 소유자를 묶어 다른 행으로 옮긴 암호문은 복호화되지 않게 한다. */
const aad = (ownerId: string) => `drive:${ownerId}`;

export class PgDriveConnections implements DriveConnectionStore {
  constructor(private readonly pool: pg.Pool, private readonly vault: TokenVault) {}

  async save(ownerId: string, email: string, refreshToken: string, scope: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO drive_connections (owner_id, email, scope, refresh_token_enc) VALUES ($1,$2,$3,$4)
       ON CONFLICT (owner_id) DO UPDATE SET email=EXCLUDED.email, scope=EXCLUDED.scope, refresh_token_enc=EXCLUDED.refresh_token_enc,
         status='CONNECTED', last_error_code=NULL, connected_at=now(), updated_at=now()`,
      [ownerId, email, scope, this.vault.encrypt(refreshToken, aad(ownerId))]);
  }

  async state(ownerId: string): Promise<ConnectionState> {
    const r = await this.pool.query('SELECT status FROM drive_connections WHERE owner_id=$1', [ownerId]);
    return r.rows[0] ? (r.rows[0].status as ConnectionState) : 'NONE';
  }

  /** 복호화 가능한 갱신 토큰. 없거나 복호화 실패면 null(재연결 필요). */
  async refreshToken(ownerId: string): Promise<{ token: string } | { problem: 'NOT_CONNECTED' | 'AUTH_EXPIRED' }> {
    const r = await this.pool.query('SELECT refresh_token_enc, status FROM drive_connections WHERE owner_id=$1', [ownerId]);
    if (!r.rows[0]) return { problem: 'NOT_CONNECTED' };
    if (r.rows[0].status !== 'CONNECTED') return { problem: 'AUTH_EXPIRED' };
    const t = this.vault.decrypt(r.rows[0].refresh_token_enc as string, aad(ownerId));
    if (!t) {
      await this.markExpired(ownerId, 'TOKEN_UNREADABLE');
      return { problem: 'AUTH_EXPIRED' };
    }
    return { token: t };
  }

  async markExpired(ownerId: string, code: string): Promise<void> {
    await this.pool.query(`UPDATE drive_connections SET status='AUTH_EXPIRED', last_error_code=$2, updated_at=now() WHERE owner_id=$1`, [ownerId, code]);
  }

  async rootFolder(ownerId: string): Promise<string | null> {
    return ((await this.pool.query('SELECT root_folder_id FROM drive_connections WHERE owner_id=$1', [ownerId])).rows[0]?.root_folder_id as string | null) ?? null;
  }

  async setRootFolder(ownerId: string, id: string): Promise<void> {
    await this.pool.query('UPDATE drive_connections SET root_folder_id=$2, updated_at=now() WHERE owner_id=$1', [ownerId, id]);
  }

  async disconnect(ownerId: string): Promise<string | null> {
    const r = await this.pool.query('DELETE FROM drive_connections WHERE owner_id=$1 RETURNING refresh_token_enc', [ownerId]);
    return r.rows[0] ? this.vault.decrypt(r.rows[0].refresh_token_enc as string, aad(ownerId)) : null;
  }
}
