import { useCallback, useEffect, useRef, useState } from 'react';
import { AttachPanel } from './AttachPanel';
import { uploadAttachment } from './attach';
import { openMic, Player, type MicSession } from './audio';
import {
  classifyMicError, describeLatency, describeStop, formatClock, MIC_HELP, micIsOn, nextPhase, NOTICE_HELP, PHASE_LABEL, remainingMs, summarizeLatency,
  type InterviewState, type MicProblem, type Phase, type ServerEvent, type StopInfo, type TurnLat,
} from './interview';

const POLL_MS = 8000;
const THINK_AFTER_SILENCE_MS = 600;
const rms = (b: ArrayBuffer) => {
  const v = new Int16Array(b);
  let s = 0;
  for (let i = 0; i < v.length; i++) { const x = v[i]! / 32768; s += x * x; }
  return v.length ? Math.sqrt(s / v.length) : 0;
};

type TextMode = null | 'learning' | 'correction';
const TEXT_MODE: Record<Exclude<TextMode, null>, { open: string; label: string; file: string }> = {
  learning: { open: '학습 내용을 글로 쓰기', label: '학습 내용 (선택)', file: 'learning.md' },
  correction: { open: '말한 내용을 글로 정확히 고치기', label: '정확히 고칠 내용 (선택)', file: 'correction.md' },
};

/**
 * 버튼·음성 중심 대화 화면. 시작 버튼을 누르기 전에는 마이크를 열지 않고, 한 번 시작하면 답변마다 버튼 없이 이어진다.
 * 글 입력은 학습 작성·정밀 수정을 고른 때만 나타난다(문장 입력을 강제하지 않는다).
 */
export function InterviewScreen() {
  const [recordId, setRecordId] = useState<string | null>(null);
  const [state, setState] = useState<InterviewState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stop, setStop] = useState<StopInfo | null>(null);
  const [micProblem, setMicProblem] = useState<MicProblem | null>(null);
  const [notice, setNotice] = useState('');
  const [wrapUp, setWrapUp] = useState(false);
  const [lats, setLats] = useState<TurnLat[]>([]);
  const [usedMs, setUsedMs] = useState(0);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [textMode, setTextMode] = useState<TextMode>(null);
  const [text, setText] = useState('');
  const [textMsg, setTextMsg] = useState('');

  const ws = useRef<WebSocket | null>(null);
  const mic = useRef<MicSession | null>(null);
  const player = useRef<Player | null>(null);
  const ready = useRef(false);
  const running = useRef(false);
  const phaseRef = useRef<Phase>('idle');
  const baseUsed = useRef(0);
  const readyAt = useRef(0);
  const lastVoice = useRef(0);
  const sawVoice = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const go = useCallback((p: Phase) => { phaseRef.current = p; setPhase(p); }, []);

  const refresh = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/interview/${id}/state`);
      if (!r.ok) throw new Error(String(r.status));
      const s = (await r.json()) as InterviewState;
      setState(s); setLoadError(false);
      if (!running.current) {
        setUsedMs(s.usage.usedMs);
        if (!s.canTalk && s.blockReason && phaseRef.current !== 'ended') { go('blocked'); setStop(describeStop(s.blockReason)); }
        else if (phaseRef.current === 'blocked') { go('idle'); setStop(null); }
      }
    } catch { setLoadError(true); }
  }, [go]);

  // 기록 열기(오늘 생활일, 이미 있으면 이어보기) → 상태 조회.
  useEffect(() => {
    let alive = true;
    fetch('/api/records', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j: { id: string }) => { if (alive) { setRecordId(j.id); void refresh(j.id); } })
      .catch(() => { if (alive) setLoadError(true); });
    return () => { alive = false; };
  }, [refresh]);

  // 다른 기기(PC↔휴대폰)에서 쌓은 대화를 이어 보려고 대화 중이 아닐 때 주기적으로 다시 읽는다.
  useEffect(() => {
    if (!recordId) return;
    const t = setInterval(() => { if (!running.current) void refresh(recordId); }, POLL_MS);
    const onFocus = () => { if (!running.current) void refresh(recordId); };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [recordId, refresh]);

  // 남은 시간 표시(서버가 보낸 이번 연결 시작 시각 기준).
  useEffect(() => {
    if (phase !== 'listening' && phase !== 'thinking' && phase !== 'speaking') return;
    const t = setInterval(() => setUsedMs(baseUsed.current + (Date.now() - readyAt.current)), 500);
    return () => clearInterval(t);
  }, [phase]);

  const releaseMic = useCallback(() => {
    mic.current?.stop(); mic.current = null;
    player.current?.stop(); player.current = null;
    ready.current = false;
  }, []);

  const finish = useCallback((reason: string, message?: string) => {
    if (stopTimer.current) { clearTimeout(stopTimer.current); stopTimer.current = null; }
    running.current = false;
    releaseMic();
    const info = describeStop(reason);
    setStop(message && reason !== 'USER_PAUSE' ? { ...info, title: info.title } : info);
    go(info.phase);
    setConfirmEnd(false);
    if (recordId) void refresh(recordId);
  }, [go, recordId, refresh, releaseMic]);

  const onEvent = useCallback((ev: ServerEvent) => {
    if (ev.type === 'ready') {
      ready.current = true; baseUsed.current = Number(ev.usedMs) || 0; readyAt.current = Date.now(); setUsedMs(baseUsed.current);
      setNotice(''); setStop(null); setWrapUp(false);
      go(nextPhase(phaseRef.current, ev, false));
    } else if (ev.type === 'wrap_up') {
      setWrapUp(true);
    } else if (ev.type === 'notice') {
      setNotice(NOTICE_HELP[String(ev.code)] ?? String(ev.message ?? ''));
    } else if (ev.type === 'interrupted') {
      player.current?.stop(); go('listening');
    } else if (ev.type === 'first_audio') {
      setNotice(''); go('speaking');
    } else if (ev.type === 'turn') {
      setNotice('');
      setLats((xs) => [...xs, { n: Number(ev.n), latencyMs: (ev.latencyMs as number | null) ?? null, upstreamLatencyMs: (ev.upstreamLatencyMs as number | null) ?? null, serverOverheadMs: (ev.serverOverheadMs as number | null) ?? null }]);
      go(nextPhase(phaseRef.current, ev, !!player.current?.playing));
      // 저장이 끝난 대화를 서버에서 다시 읽는다(화면에는 저장된 것만 보인다).
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => { if (recordId) void refresh(recordId); }, 400);
    } else if (ev.type === 'stopped') {
      if (typeof ev.usedMs === 'number') setUsedMs(ev.usedMs);
      finish(String(ev.reason), String(ev.message ?? ''));
    }
  }, [finish, go, recordId, refresh]);

  const startTalk = useCallback(async () => {
    if (!recordId || running.current) return;
    if (stopTimer.current) { clearTimeout(stopTimer.current); stopTimer.current = null; }
    setMicProblem(null); setStop(null); setNotice(''); setConfirmEnd(false);
    go('asking-mic');
    let opened;
    try {
      // 시작 버튼을 누른 뒤에만 마이크를 연다. 거부되면 서버 연결·녹음 없이 안내한다.
      opened = await openMic(16000, (pcm) => {
        const s = ws.current;
        if (!s || s.readyState !== WebSocket.OPEN || !ready.current) return;
        s.send(pcm);
        const v = rms(pcm) > 0.02, now = Date.now();
        if (v) { lastVoice.current = now; sawVoice.current = true; }
        else if (sawVoice.current && now - lastVoice.current > THINK_AFTER_SILENCE_MS && phaseRef.current === 'listening') { sawVoice.current = false; go('thinking'); }
      });
    } catch (e) {
      setMicProblem(classifyMicError(e)); go('idle');
      return;
    }
    mic.current = opened.session;
    player.current = new Player(opened.ctx, () => { if (running.current && phaseRef.current === 'speaking') go('listening'); });
    running.current = true; sawVoice.current = false;
    go('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/api/interview/ws?id=${encodeURIComponent(recordId)}`);
    sock.binaryType = 'arraybuffer';
    ws.current = sock;
    sock.onmessage = (e) => {
      if (typeof e.data === 'string') { try { onEvent(JSON.parse(e.data) as ServerEvent); } catch { /* 무시 */ } }
      else player.current?.push(e.data as ArrayBuffer);
    };
    sock.onclose = () => { if (ws.current === sock && running.current) { ws.current = null; finish('CONNECTION_LOST'); } };
    sock.onerror = () => { /* onclose 에서 처리 */ };
  }, [finish, go, onEvent, recordId]);

  const pause = useCallback(() => {
    // 마이크는 누르는 즉시 끈다. 서버에는 일시정지를 알려 지금까지의 대화를 저장하게 한다.
    mic.current?.stop(); mic.current = null; player.current?.stop();
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) {
      try { s.send(JSON.stringify({ type: 'pause' })); } catch { /* 닫힘 */ }
      stopTimer.current = setTimeout(() => { if (running.current) finish('USER_PAUSE'); }, 2500);
    } else finish('USER_PAUSE');
  }, [finish]);

  const endToday = useCallback(() => {
    mic.current?.stop(); mic.current = null; player.current?.stop();
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) {
      try { s.send(JSON.stringify({ type: 'end' })); } catch { /* 닫힘 */ }
      stopTimer.current = setTimeout(() => { if (running.current) finish('USER_END'); }, 2500);
    } else finish('USER_END');
  }, [finish]);

  useEffect(() => () => {
    running.current = false;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    if (stopTimer.current) clearTimeout(stopTimer.current);
    const s = ws.current; ws.current = null;
    try { s?.close(); } catch { /* 닫힘 */ }
    mic.current?.stop(); player.current?.stop();
  }, []);

  const saveText = async () => {
    if (!recordId || !textMode || !text.trim()) return;
    setTextMsg('저장 중…');
    const r = await uploadAttachment({ recordId, kind: 'NOTE', key: `ui-${crypto.randomUUID()}`, name: TEXT_MODE[textMode].file, body: text });
    if (r.ok) { setTextMsg('저장했습니다.'); setText(''); setTextMode(null); if (recordId) void refresh(recordId); }
    else setTextMsg(r.message ?? '저장하지 못했습니다. 다시 시도해 주세요.');
  };

  const talking = phase === 'connecting' || phase === 'listening' || phase === 'thinking' || phase === 'speaking' || phase === 'asking-mic';
  const canStart = !!recordId && !!state && !talking && phase !== 'ended' && phase !== 'blocked' && (state?.canTalk ?? false);
  const resumed = (state?.usage.usedMs ?? 0) > 0 || (state?.conversation.length ?? 0) > 0;
  const lim = state?.usage.limits;
  const left = lim ? remainingMs({ usedMs, limits: lim }) : 0;
  const sum = summarizeLatency(lats);

  return (
    <section data-testid="interview" aria-labelledby="iv-h" className="interview">
      <h2 id="iv-h">오늘 대화</h2>
      <p data-testid="iv-status" role="status" aria-live="polite" className="iv-status">{PHASE_LABEL[phase]}</p>
      <p data-testid="mic-indicator" data-on={micIsOn(phase) ? 'true' : 'false'} className={micIsOn(phase) ? 'mic on' : 'mic'}>
        {micIsOn(phase) ? '● 녹음 중 (마이크 켜짐)' : '마이크 꺼짐 · 녹음하지 않음'}
      </p>
      {lim && <p data-testid="iv-clock" className="meta">남은 대화 시간 {formatClock(left)} · 하루 1회, 최대 {Math.round(lim.maxMs / 60000)}분</p>}
      {wrapUp && <p data-testid="iv-wrap" role="status" className="banner">곧 마무리합니다. 오늘 꼭 남기고 싶은 말을 해 주세요.</p>}
      {notice && <p data-testid="iv-notice" role="status" className="notice">{notice}</p>}

      <div className="iv-actions">
        {canStart && <button data-testid="btn-start" className="button" onClick={() => void startTalk()}>{resumed ? '이어서 말하기' : '대화 시작'}</button>}
        {talking && <button data-testid="btn-pause" onClick={pause} disabled={phase === 'asking-mic'}>일시정지</button>}
        {talking && !confirmEnd && <button data-testid="btn-end" onClick={() => setConfirmEnd(true)} disabled={phase === 'asking-mic'}>오늘 대화 끝내기</button>}
        {confirmEnd && (
          <span role="group" aria-label="끝내기 확인">
            <span>오늘은 다시 시작할 수 없습니다. 끝낼까요?</span>{' '}
            <button data-testid="btn-end-confirm" onClick={endToday}>끝내기</button>{' '}
            <button onClick={() => setConfirmEnd(false)}>계속하기</button>
          </span>
        )}
        <button data-testid="btn-attach" aria-expanded={showAttach} aria-controls="iv-attach" onClick={() => setShowAttach((v) => !v)}>{showAttach ? '첨부 닫기' : '사진·자료 첨부'}</button>
      </div>

      {micProblem && (
        <div data-testid="mic-problem" role="alert" className="problem">
          <strong>{MIC_HELP[micProblem].title}</strong>
          <p>{MIC_HELP[micProblem].steps}</p>
          <button data-testid="btn-retry" onClick={() => void startTalk()}>다시 시도</button>
          <p className="meta">마이크 없이도 아래 [글로 남기기]와 사진 첨부로 기록할 수 있습니다. 기존 기록 {state?.conversation.length ?? 0}개는 그대로 있습니다.</p>
        </div>
      )}

      {stop && (
        <div data-testid="iv-stop" role="alert" className="problem" data-resumable={stop.resumable}>
          <strong>{stop.title}</strong>
          <p>{stop.action}</p>
          {stop.resumable && phase !== 'idle' && !talking && state?.canTalk && <button data-testid="btn-reconnect" onClick={() => void startTalk()}>{phase === 'paused' && stop.title.startsWith('일시정지') ? '이어서 말하기' : '다시 연결'}</button>}
        </div>
      )}

      {loadError && <p role="alert" data-testid="iv-load-error">기록을 불러오지 못했습니다. 연결을 확인하고 새로고침해 주세요. 이미 저장된 내용은 사라지지 않습니다.</p>}

      {state?.audioNotice && (
        <div data-testid="audio-notice" role="note" className="problem">
          <strong>이전 음성은 이어갈 수 없습니다</strong>
          <p>{state.audioNotice.message}</p>
          {'speechSynthesis' in window && <button data-testid="btn-speak-notice" onClick={() => { const u = new SpeechSynthesisUtterance(state.audioNotice!.speech); u.lang = 'ko-KR'; window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); }}>음성으로 듣기</button>}
        </div>
      )}

      <h3>저장된 대화</h3>
      {state && state.conversation.length === 0 && <p data-testid="iv-empty" className="meta">아직 저장된 대화가 없습니다. 버튼을 누르고 말을 시작하세요.</p>}
      <ol data-testid="iv-conversation" aria-label="저장된 대화" className="conv">
        {state?.conversation.map((c) => <li key={c.id} data-kind={c.kind}><strong>{c.kind === 'ANSWER' ? '나' : 'AI'}</strong> {c.body}</li>)}
      </ol>

      {lats.length > 0 && (
        <details data-testid="iv-latency" open>
          <summary>응답 대기 시간 · 평균 {sum.avgMs ?? '-'}ms · 최대 {sum.maxMs ?? '-'}ms</summary>
          <ul>{lats.map((t) => <li key={t.n}>{describeLatency(t)}</li>)}</ul>
        </details>
      )}

      <div className="iv-text">
        {textMode === null ? (
          <>
            <button data-testid="btn-text-learning" onClick={() => { setTextMode('learning'); setTextMsg(''); }}>{TEXT_MODE.learning.open}</button>{' '}
            <button data-testid="btn-text-correction" onClick={() => { setTextMode('correction'); setTextMsg(''); }}>{TEXT_MODE.correction.open}</button>
            <p className="meta">글은 필요할 때만 쓰면 됩니다. 말로만 기록해도 됩니다.</p>
          </>
        ) : (
          <>
            <label htmlFor="iv-text">{TEXT_MODE[textMode].label}</label>
            <textarea id="iv-text" data-testid="iv-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', boxSizing: 'border-box' }} />
            <button data-testid="btn-text-save" onClick={() => void saveText()} disabled={!text.trim()}>저장</button>{' '}
            <button onClick={() => { setTextMode(null); setText(''); setTextMsg(''); }}>닫기</button>
          </>
        )}
        {textMsg && <p data-testid="iv-text-msg" role="status">{textMsg}</p>}
      </div>

      <div id="iv-attach" hidden={!showAttach}><AttachPanel /></div>
    </section>
  );
}
