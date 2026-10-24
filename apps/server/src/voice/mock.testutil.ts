import { pcmToWav, type Transports } from './transports.js';

export interface MockCalls { stt: number; pro: number; tts: number; prompts: string[] }

/** 모의 STT·Pro·TTS transport. 네트워크를 쓰지 않는다. */
export function mockTransports(o: { sttText?: string | (() => string); pro?: { state: string; text?: string }; sttThrows?: boolean; ttsThrows?: boolean; delayMs?: number } = {}) {
  const calls: MockCalls = { stt: 0, pro: 0, tts: 0, prompts: [] };
  const sleep = () => (o.delayMs ? new Promise((r) => setTimeout(r, o.delayMs)) : Promise.resolve());
  const t: Transports = {
    async stt() {
      calls.stt++;
      await sleep();
      if (o.sttThrows) throw new Error('boom');
      const v = o.sttText ?? '오늘은 산책을 했어요';
      return { text: typeof v === 'function' ? v() : v, seconds: 2 };
    },
    async pro(prompt) {
      calls.pro++;
      calls.prompts.push(prompt);
      await sleep();
      return o.pro ?? { state: 'SUCCEEDED', text: '산책은 어디에서 하셨나요?' };
    },
    async tts() {
      calls.tts++;
      await sleep();
      if (o.ttsThrows) throw new Error('boom');
      const pcm = Buffer.alloc(24000 * 2 * 0.6); // 0.6초 저음 톤(모의)
      for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(3000 * Math.sin(i / 20)), i * 2);
      return { audio: pcmToWav(pcm), mime: 'audio/wav', outputSeconds: 0.6 };
    },
  };
  return { t, calls };
}
