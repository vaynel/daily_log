/** 마이크 캡처(16kHz PCM16)와 AI 음성 재생(24kHz PCM16). getUserMedia 는 start() 안에서만 호출한다(시작 전 녹음 없음). */

const WORKLET = 'class P extends AudioWorkletProcessor{process(i){var c=i[0]&&i[0][0];if(c){this.port.postMessage(c.slice(0));}return true;}}registerProcessor("mic-cap",P);';

export interface MicSession {
  stop(): void;
  readonly active: boolean;
}

export async function openMic(inputRate: number, onChunk: (pcm: ArrayBuffer) => void, ctxFactory: () => AudioContext = () => new AudioContext()): Promise<{ ctx: AudioContext; session: MicSession }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = ctxFactory();
  let active = true;
  let node: AudioWorkletNode | null = null;
  const stop = () => {
    if (!active) return;
    active = false;
    try { node?.disconnect(); } catch { /* 이미 해제 */ }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'mic-cap');
    let carry = new Float32Array(0), pos = 0;
    const out: number[] = [];
    const chunk = Math.round(inputRate * 0.04);
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!active) return;
      const x = e.data;
      const a = new Float32Array(carry.length + x.length);
      a.set(carry, 0); a.set(x, carry.length);
      const ratio = ctx.sampleRate / inputRate;
      let p = pos;
      while (p + ratio <= a.length) {
        const s = Math.floor(p), en = Math.floor(p + ratio);
        let sum = 0, c = 0;
        for (let j = s; j < en; j++) { sum += a[j]!; c++; }
        out.push(c ? sum / c : a[s]!);
        p += ratio;
      }
      const f = Math.floor(p);
      carry = a.slice(f); pos = p - f;
      while (out.length >= chunk) {
        const i16 = new Int16Array(chunk);
        for (let k = 0; k < chunk; k++) { const v = Math.max(-1, Math.min(1, out[k]!)); i16[k] = v < 0 ? v * 32768 : v * 32767; }
        out.splice(0, chunk);
        onChunk(i16.buffer);
      }
    };
    src.connect(node);
    const mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute); mute.connect(ctx.destination);
  } catch (e) {
    stop();
    throw Object.assign(new Error('worklet'), { name: 'NotSupportedError', cause: e });
  }
  return { ctx, session: { stop, get active() { return active; } } };
}

/** AI 음성을 이어 붙여 재생한다. stop() 은 끼어들기·일시정지 때 즉시 멈춘다. */
export class Player {
  private nextT = 0;
  private sources = new Set<AudioBufferSourceNode>();
  constructor(private readonly ctx: AudioContext, private readonly onIdle: () => void) {}
  get playing() { return this.sources.size > 0; }
  push(ab: ArrayBuffer) {
    const bytes = ab.byteLength - (ab.byteLength % 2);
    if (!bytes) return;
    const i16 = new Int16Array(ab.slice(0, bytes));
    const f = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f[i] = i16[i]! / 32768;
    const b = this.ctx.createBuffer(1, f.length, 24000);
    b.copyToChannel(f, 0);
    const s = this.ctx.createBufferSource();
    s.buffer = b; s.connect(this.ctx.destination);
    const t = Math.max(this.ctx.currentTime + 0.02, this.nextT);
    s.start(t); this.nextT = t + b.duration;
    this.sources.add(s);
    s.onended = () => { this.sources.delete(s); if (!this.sources.size) this.onIdle(); };
  }
  stop() {
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch { /* 이미 종료 */ } }
    this.sources.clear(); this.nextT = 0;
  }
}
