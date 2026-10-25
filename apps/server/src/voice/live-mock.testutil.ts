import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface MockLiveOptions {
  /** 이 키만 허용. 다르면 업그레이드를 401로 거부. */
  expectedKey: string;
  /** 사용자 말 끝(무음 감지)으로 보는 마지막 음성 입력 이후 시간. */
  vadSilenceMs?: number;
  /** 무음 감지 후 첫 오디오까지 모델 지연. */
  firstAudioDelayMs?: number;
  audioChunks?: number;
  /** 턴마다 쌓이는 맥락 토큰(PM 실측 약 520). */
  tokensPerTurn?: number;
  baseTokens?: number;
  outputTokens?: number;
  /** 응답 도중 업스트림을 일방적으로 끊는다(연결 중단 시험). */
  dropAfterTurns?: number;
  /** 응답 오디오를 보내는 간격. */
  chunkIntervalMs?: number;
}

export interface MockLiveState {
  setups: Record<string, unknown>[];
  keysSeen: string[];
  audioMsgs: number;
  turnsAnswered: number;
  interrupts: number;
  /** 턴마다 보고한 promptTokenCount. */
  promptTokens: number[];
  connections: number;
  /** realtimeInput.text 로 받은 진행 안내(마무리 전환 등). */
  textInputs: string[];
}

const rms = (b: Buffer) => {
  let s = 0; const n = b.length >> 1;
  for (let i = 0; i < n; i++) { const v = b.readInt16LE(i * 2) / 32768; s += v * v; }
  return n ? Math.sqrt(s / n) : 0;
};

/** 모의 Gemini Live(BidiGenerateContent). 실제 API를 호출하지 않는다. 맥락 누적과 contextWindowCompression 을 흉내 낸다. */
export async function startMockLive(o: MockLiveOptions) {
  const st: MockLiveState = { setups: [], keysSeen: [], audioMsgs: 0, turnsAnswered: 0, interrupts: 0, promptTokens: [], connections: 0, textInputs: [] };
  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    const key = String(req.headers['x-goog-api-key'] ?? '');
    st.keysSeen.push(key);
    if (key !== o.expectedKey) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => session(ws));
  });

  function session(ws: WebSocket) {
    st.connections++;
    let context = 0;
    let trigger = 0, target = 0;
    let voiceTimer: NodeJS.Timeout | null = null;
    let speaking: NodeJS.Timeout | null = null;
    let heardVoice = false;
    let pendingTurn = false;
    let turnsHere = 0;
    const base = o.baseTokens ?? 550, per = o.tokensPerTurn ?? 520;
    const send = (m: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };

    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as {
        setup?: Record<string, unknown> & { contextWindowCompression?: { triggerTokens?: number; slidingWindow?: { targetTokens?: number } } };
        realtimeInput?: { audio?: { data: string }; text?: string };
      };
      if (m.setup) {
        st.setups.push(m.setup);
        const c = m.setup.contextWindowCompression;
        trigger = Number(c?.triggerTokens ?? 0); target = Number(c?.slidingWindow?.targetTokens ?? 0);
        context = base;
        send({ setupComplete: {} });
        return;
      }
      if (typeof m.realtimeInput?.text === 'string') { st.textInputs.push(m.realtimeInput.text); answer(); return; }
      const data = m.realtimeInput?.audio?.data;
      if (!data) return;
      st.audioMsgs++;
      const voiced = rms(Buffer.from(data, 'base64')) > 0.02;
      if (!voiced) return;
      if (speaking) { // 끼어들기
        clearInterval(speaking); speaking = null; st.interrupts++;
        send({ serverContent: { interrupted: true } });
      }
      heardVoice = true; pendingTurn = true;
      if (voiceTimer) clearTimeout(voiceTimer);
      voiceTimer = setTimeout(() => { if (heardVoice && pendingTurn) { heardVoice = false; answer(); } }, o.vadSilenceMs ?? 250);
    });

    function answer() {
      pendingTurn = false;
      const n = ++turnsHere;
      setTimeout(() => {
        if (ws.readyState !== ws.OPEN) return;
        context += per;
        if (trigger > 0 && context > trigger) context = Math.max(base, target); // 슬라이딩 윈도우 압축
        st.promptTokens.push(context);
        send({ serverContent: { inputTranscription: { text: `사용자 발화 ${n}` } } });
        const chunks = o.audioChunks ?? 5;
        let i = 0;
        speaking = setInterval(() => {
          const pcm = Buffer.alloc(24000 * 2 * 0.1); // 100ms
          for (let k = 0; k < pcm.length / 2; k++) pcm.writeInt16LE(Math.round(3000 * Math.sin(k / 20)), k * 2);
          send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm.toString('base64') } }] } } });
          if (i === 0) send({ serverContent: { outputTranscription: { text: `네, ${n}번째 이야기군요. ` } } });
          if (++i >= chunks) {
            clearInterval(speaking!); speaking = null;
            send({ serverContent: { outputTranscription: { text: '어땠나요?' } } });
            send({ usageMetadata: { promptTokenCount: context, responseTokenCount: o.outputTokens ?? 200 } });
            send({ serverContent: { turnComplete: true } });
            st.turnsAnswered++;
            if (o.dropAfterTurns !== undefined && turnsHere >= o.dropAfterTurns) ws.terminate();
          }
        }, o.chunkIntervalMs ?? 20);
      }, o.firstAudioDelayMs ?? 30);
    }
    ws.on('close', () => { if (speaking) clearInterval(speaking); if (voiceTimer) clearTimeout(voiceTimer); });
  }

  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/live`, state: st,
    close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(); http.close(() => r()); }),
  };
}
