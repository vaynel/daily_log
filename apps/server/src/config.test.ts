import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const ok = { DATABASE_URL: 'postgres://u:p@h/db', FILE_STORAGE_DIR: './d', SESSION_SECRET: 'x'.repeat(16) };

describe('loadConfig', () => {
  it('필수 값이 있으면 기본값과 함께 로드', () => {
    expect(loadConfig(ok)).toMatchObject({ port: 3000, host: '127.0.0.1' });
  });
  it('누락 항목을 모두 나열하고 값은 노출하지 않음', () => {
    try {
      loadConfig({ SESSION_SECRET: 'short-secret' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain('DATABASE_URL 누락');
      expect(msg).toContain('FILE_STORAGE_DIR 누락');
      expect(msg).toContain('SESSION_SECRET 값이 너무 짧음');
      expect(msg).not.toContain('short-secret');
    }
  });
  it('잘못된 PORT 거부', () => {
    expect(() => loadConfig({ ...ok, PORT: '99999' })).toThrow(/PORT/);
  });
});
