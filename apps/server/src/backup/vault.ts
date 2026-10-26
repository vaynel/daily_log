import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Drive 갱신 토큰 암호화 보관. AES-256-GCM, 키는 DRIVE_TOKEN_KEY(없으면 SESSION_SECRET)에서 HKDF 로 유도한다.
 * 형식: v1.<iv>.<tag>.<ciphertext> (base64url). 복호화 실패(키 변경·변조)는 null → 호출자는 재연결이 필요한 상태로 다룬다.
 */
export class TokenVault {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (secret.length < 16) throw new Error('토큰 암호화 키가 너무 짧음');
    this.key = Buffer.from(hkdfSync('sha256', secret, 'daily-log', 'drive-refresh-token-v1', 32));
  }

  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(blob: string, aad: string): string | null {
    const [v, iv, tag, ct] = blob.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
