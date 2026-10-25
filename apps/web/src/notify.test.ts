import { describe, expect, it } from 'vitest';
import { isValidTime, recordIdFromSearch, urlBase64ToUint8Array } from './notify';

describe('notify helpers', () => {
  it('알림 클릭 주소에서는 올바른 UUID 기록 ID 만 받는다', () => {
    const id = '3f2b8f0e-1c4a-4d57-9a0e-0b6f6f6f6f6f';
    expect(recordIdFromSearch(`?record=${id}`)).toBe(id);
    expect(recordIdFromSearch('?record=../../x')).toBeNull();
    expect(recordIdFromSearch('')).toBeNull();
  });
  it('시각 형식 검사는 서버와 같은 24시간 HH:MM', () => {
    expect(['00:00', '22:00', '23:59'].every(isValidTime)).toBe(true);
    expect(['24:00', '9:00', '22:60', ''].some(isValidTime)).toBe(false);
  });
  it('VAPID 공개키(base64url) 변환', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255]);
  });
});
