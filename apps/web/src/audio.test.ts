import { describe, expect, it, vi } from 'vitest';
import { openMic } from './audio.js';

describe('openMic', () => {
  it('에코 제거·잡음 억제·자동 이득을 켜서 마이크를 연다', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('x', 'NotAllowedError'));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await expect(openMic(16000, () => {})).rejects.toBeDefined();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    vi.unstubAllGlobals();
  });
});
