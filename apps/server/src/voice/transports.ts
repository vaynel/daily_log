/** 외부 호출 경계. 러너 시험은 모의 transport만 쓰고, 실제 구현은 PM 실측 때만 연결된다. 오류에는 본문·키를 담지 않는다. */
export interface SttResult { text: string; seconds: number }
export interface TtsResult { audio: Buffer; mime: string; outputSeconds: number }
export interface Transports {
  stt(audio: Buffer, mime: string, durationSec: number): Promise<SttResult>;
  /** Pro 텍스트 응답. 성공이 아니면 state 코드만 돌려준다. */
  pro(prompt: string): Promise<{ state: string; text?: string }>;
  tts(text: string): Promise<TtsResult>;
}

export class TransportError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'TransportError';
  }
}

const extOf = (mime: string) => (mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm');

export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bits = 16): Buffer {
  const h = Buffer.alloc(44);
  const align = channels * (bits / 8);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * align, 28); h.writeUInt16LE(align, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** RIFF/WAV 에서 fmt 와 data 청크만 꺼낸다. 그 밖의 청크(C2PA 등)는 소리로 재생되지 않게 버린다. */
export function parseWav(buf: Buffer): { pcm: Buffer; sampleRate: number; channels: number; bits: number } | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let fmt: { sampleRate: number; channels: number; bits: number } | null = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) return null;
      // 스트리밍 헤더의 0/0xFFFFFFFF 길이나 잘린 파일은 실제 남은 바이트까지로 제한한다.
      const end = Math.min(body + size, buf.length);
      return { pcm: buf.subarray(body, size === 0 || size === 0xffffffff ? buf.length : end), ...fmt };
    }
    off = body + size + (size % 2);
  }
  return null;
}

export function openaiStt(key: string, fetchImpl: typeof fetch = fetch, model = 'gpt-4o-mini-transcribe') {
  return async (audio: Buffer, mime: string, durationSec: number): Promise<SttResult> => {
    const form = new FormData();
    form.set('model', model);
    form.set('language', 'ko');
    form.set('file', new Blob([new Uint8Array(audio)], { type: mime }), `utterance.${extOf(mime)}`);
    const res = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
    });
    if (!res.ok) throw new TransportError(`STT_HTTP_${res.status}`);
    const body = (await res.json()) as { text?: unknown };
    return { text: typeof body.text === 'string' ? body.text : '', seconds: durationSec };
  };
}

export function geminiTts(key: string, fetchImpl: typeof fetch = fetch, model = 'gemini-3.8-flash-tts', voice = 'Kore') {
  return async (text: string): Promise<TtsResult> => {
    // 키는 URL이 아니라 헤더로만 보낸다(접근 로그에 남지 않게).
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    });
    if (!res.ok) throw new TransportError(`TTS_HTTP_${res.status}`);
    const body = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] };
    const inline = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) throw new TransportError('TTS_EMPTY');
    const raw = Buffer.from(inline.data, 'base64');
    // audio/wav 또는 RIFF 로 시작하면 이미 WAV 다. 다시 감싸면 내부 헤더·C2PA 청크가 소리로 재생된다.
    if ((inline.mimeType ?? '').toLowerCase().includes('wav') || raw.toString('latin1', 0, 4) === 'RIFF') {
      const w = parseWav(raw);
      if (!w || w.pcm.length === 0 || w.bits === 0 || w.channels === 0) throw new TransportError('TTS_BAD_WAV');
      const bytesPerSec = w.sampleRate * w.channels * (w.bits / 8);
      return { audio: pcmToWav(w.pcm, w.sampleRate, w.channels, w.bits), mime: 'audio/wav', outputSeconds: w.pcm.length / bytesPerSec };
    }
    const pcm = raw;
    return { audio: pcmToWav(pcm), mime: 'audio/wav', outputSeconds: pcm.length / 2 / 24000 };
  };
}

type Infer = (store: unknown, input: { model: string; text: string }, opts: { supportVerified: boolean }) => Promise<{ state: string; text?: string }>;

/** scripts/siwc runtime.infer 연결. supportVerified 는 서버 설정에서만 오며 요청 입력과 무관하다. */
export function siwcPro(infer: Infer, store: unknown, model: string, supportVerified: boolean) {
  return (prompt: string) => infer(store, { model, text: prompt }, { supportVerified });
}
