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

export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
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
    const body = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
    const data = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
    if (!data) throw new TransportError('TTS_EMPTY');
    const pcm = Buffer.from(data, 'base64');
    return { audio: pcmToWav(pcm), mime: 'audio/wav', outputSeconds: pcm.length / 2 / 24000 };
  };
}

type Infer = (store: unknown, input: { model: string; text: string }, opts: { supportVerified: boolean }) => Promise<{ state: string; text?: string }>;

/** scripts/siwc runtime.infer 연결. supportVerified 는 서버 설정에서만 오며 요청 입력과 무관하다. */
export function siwcPro(infer: Infer, store: unknown, model: string, supportVerified: boolean) {
  return (prompt: string) => infer(store, { model, text: prompt }, { supportVerified });
}
