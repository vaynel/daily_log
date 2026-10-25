/** 실시간 음성 대화 시험 화면(단일 HTML, /voice-live). 한 번 시작하면 버튼 없이 계속 대화한다. 템플릿 리터럴/백틱을 쓰지 않는다. */
export const LIVE_PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>실시간 음성 대화 시험</title>
<style>
:root{color-scheme:light dark;--bg:#faf8f4;--fg:#222;--muted:#666;--accent:#2f5d50;--warn:#9a3412;--card:#fff;--line:#d9d4c8}
@media (prefers-color-scheme:dark){:root{--bg:#161a18;--fg:#eee;--muted:#aaa;--accent:#7fc4b0;--warn:#fdba74;--card:#202522;--line:#3a413d}}
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:640px;margin:0 auto;padding:16px}
h1{font-size:1.3rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:12px 0}
button{font:inherit;min-height:44px;padding:0 20px;border-radius:10px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.secondary{background:transparent;color:var(--accent)}
button:disabled{opacity:.5;cursor:default}
button:focus-visible{outline:3px solid var(--warn);outline-offset:2px}
#state{font-weight:600}
#notice{color:var(--warn);min-height:1.5em}
ol{padding-left:1.2em}
li{margin-bottom:8px}
.lat{font-weight:600;color:var(--accent)}
.meta{color:var(--muted);font-size:.9rem}
#summary-text{white-space:pre-wrap;margin:0}
</style>
</head>
<body>
<main>
<h1>실시간 음성 대화 시험</h1>
<p class="meta">내부 시험 도구입니다. 한 번 시작하면 버튼 없이 계속 대화하며, AI가 말하는 중에 말하면 끼어들 수 있습니다. 턴마다 말이 끝난 뒤 첫 음성까지의 지연(ms)을 보여 줍니다. 순차 방식 비교는 <a href="/voice-test">/voice-test</a>.</p>
<div class="card">
  <button id="start" type="button">대화 시작</button>
  <button id="stop" type="button" class="secondary" disabled>대화 끝내기</button>
  <p>상태: <span id="state" role="status" aria-live="polite">대기 중</span></p>
  <p id="notice" role="alert"></p>
</div>
<div class="card"><h2>턴별 지연</h2><ol id="turns" aria-label="대화 기록과 턴별 지연"></ol></div>
<div class="card" id="summary" hidden><h2>세션 요약</h2><pre id="summary-text" class="meta"></pre></div>
</main>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var $ = function (id) { return document.getElementById(id); };
  var ws = null, stream = null, ctx = null, node = null, src = null, sessionId = null;
  var running = false, sending = false, inRate = 16000, nextT = 0, sources = [];
  var rs = { carry: new Float32Array(0), pos: 0 }, out = [], outLen = 0, lats = [];
  var CODE_END = { BUDGET: 1, LIVE_AUTH: 1, LIVE_CONNECT: 1, LIVE_CLOSED: 1, LIVE_DISABLED: 1, BUSY: 1, CONTEXT: 1, TIME_LIMIT: 1 };

  var WORKLET = 'class P extends AudioWorkletProcessor{process(i){var c=i[0]&&i[0][0];if(c){this.port.postMessage(c.slice(0));}return true;}}registerProcessor("mic-cap",P);';

  function setState(t) { $('state').textContent = t; }
  function notice(t) { $('notice').textContent = t || ''; }

  function resample(x, inR, outR) {
    var a = new Float32Array(rs.carry.length + x.length);
    a.set(rs.carry, 0); a.set(x, rs.carry.length);
    var ratio = inR / outR, pos = rs.pos, o = [];
    while (pos + ratio <= a.length) {
      var s = Math.floor(pos), e = Math.floor(pos + ratio), sum = 0, c = 0;
      for (var j = s; j < e; j++) { sum += a[j]; c++; }
      o.push(c ? sum / c : a[s]);
      pos += ratio;
    }
    var f = Math.floor(pos);
    rs.carry = a.slice(f); rs.pos = pos - f;
    return o;
  }

  function onMicBlock(block) {
    if (!sending || !ws || ws.readyState !== 1) return;
    var r = resample(block, ctx.sampleRate, inRate);
    for (var i = 0; i < r.length; i++) out.push(r[i]);
    // 약 40ms 단위로 전송
    var chunk = Math.round(inRate * 0.04);
    while (out.length >= chunk) {
      var i16 = new Int16Array(chunk);
      for (var k = 0; k < chunk; k++) { var v = Math.max(-1, Math.min(1, out[k])); i16[k] = v < 0 ? v * 32768 : v * 32767; }
      out.splice(0, chunk);
      ws.send(i16.buffer);
    }
  }

  function playPcm(ab) {
    var i16 = new Int16Array(ab.byteLength >> 1 << 1 ? ab.slice(0, ab.byteLength >> 1 << 1) : ab);
    if (!i16.length) return;
    var f = new Float32Array(i16.length);
    for (var i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
    var b = ctx.createBuffer(1, f.length, 24000);
    b.copyToChannel(f, 0);
    var s = ctx.createBufferSource();
    s.buffer = b; s.connect(ctx.destination);
    var t = Math.max(ctx.currentTime + 0.02, nextT);
    s.start(t); nextT = t + b.duration;
    sources.push(s);
    setState('AI가 말하는 중');
    s.onended = function () {
      sources = sources.filter(function (x) { return x !== s; });
      if (!sources.length && running) setState('듣는 중');
    };
  }

  function stopPlayback() {
    sources.forEach(function (s) { try { s.onended = null; s.stop(); } catch (e) { /* 이미 종료 */ } });
    sources = []; nextT = 0;
  }

  function addTurn(t) {
    var li = document.createElement('li');
    li.id = 'turn-' + t.n;
    var lat = document.createElement('div');
    var ms = document.createElement('span');
    ms.className = 'lat';
    ms.textContent = t.latencyMs === null ? '지연 측정 없음' : '말 끝→첫 음성 ' + t.latencyMs + 'ms';
    lat.appendChild(document.createTextNode('턴 ' + t.n + ' · '));
    lat.appendChild(ms);
    var m = document.createElement('span');
    m.className = 'meta turn-meta';
    m.textContent = (t.serverOverheadMs === null ? '' : ' · 서버 추가 ' + t.serverOverheadMs + 'ms') + (t.inputTokens ? ' · 입력 ' + t.inputTokens + '토큰 · 추정 ' + t.costKrw.toFixed(1) + '원' : '') + (t.interrupted ? ' · 끼어들기로 중단됨' : '');
    lat.appendChild(m);
    var txt = document.createElement('div');
    txt.className = 'meta';
    txt.textContent = '나: ' + t.userText + ' / AI: ' + t.replyText;
    li.appendChild(lat); li.appendChild(txt);
    $('turns').appendChild(li);
    if (typeof t.latencyMs === 'number') lats.push(t.latencyMs);
  }

  function onEvent(ev) {
    if (ev.type === 'ready') {
      sessionId = ev.sessionId; inRate = ev.inputRate; sending = true;
      setState('듣는 중'); notice('');
    } else if (ev.type === 'notice') {
      notice(ev.message);
    } else if (ev.type === 'interrupted') {
      stopPlayback(); setState('듣는 중');
    } else if (ev.type === 'turn') {
      notice(''); addTurn(ev);
    } else if (ev.type === 'usage') {
      var li = $('turn-' + ev.n);
      if (li) {
        var m = li.querySelector('.turn-meta');
        if (m) m.textContent += ' · 입력 ' + ev.inputTokens + '토큰 · 추정 ' + ev.costKrw.toFixed(1) + '원';
      }
    } else if (ev.type === 'stopped') {
      if (ev.message) notice(ev.message);
      showSummary(ev.summary);
      finish(!!CODE_END[ev.reason] ? '중단됨' : '끝남');
    }
  }

  function showSummary(s) {
    if (!s) return;
    var avg = lats.length ? Math.round(lats.reduce(function (a, b) { return a + b; }, 0) / lats.length) : null;
    var mx = lats.length ? Math.max.apply(null, lats) : null;
    $('summary-text').textContent = '턴 ' + s.turns.length + ' · 평균 지연 ' + (avg === null ? '-' : avg + 'ms') + ' · 최대 ' + (mx === null ? '-' : mx + 'ms') + ' · 끼어들기 ' + s.interrupts + '회 · 입력 토큰 최대 ' + s.totals.maxInputTokens + ' · 추정 비용 ' + s.estimatedCostKrw.toFixed(1) + '원 (예산 ' + s.budgetKrw + '원)';
    $('summary').hidden = false;
  }

  function cleanup() {
    sending = false; running = false;
    stopPlayback();
    if (node) { try { node.disconnect(); } catch (e) { /* 무시 */ } node = null; }
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    if (ctx) ctx.close().catch(function () {});
    stream = null; ctx = null; src = null;
  }

  function finish(label) {
    cleanup();
    $('start').disabled = false; $('stop').disabled = true;
    setState(label);
  }

  async function start() {
    notice('');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      notice('마이크 권한이 거부되었거나 마이크를 사용할 수 없습니다. 브라우저 설정에서 허용한 뒤 다시 시작하세요.');
      setState('대기 중');
      return;
    }
    $('start').disabled = true; $('stop').disabled = false;
    $('summary').hidden = true; $('turns').textContent = ''; lats = [];
    rs = { carry: new Float32Array(0), pos: 0 }; out = [];
    setState('연결 중');
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      var url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      src = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'mic-cap');
      node.port.onmessage = function (e) { onMicBlock(e.data); };
      src.connect(node);
      var mute = ctx.createGain(); mute.gain.value = 0; node.connect(mute); mute.connect(ctx.destination);
    } catch (e) {
      notice('이 브라우저는 실시간 마이크 처리를 지원하지 않습니다.');
      return finish('대기 중');
    }
    running = true;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var qs = [];
    ['noSpeechMs', 'minSpeechMs'].forEach(function (k) { if (q.get(k)) qs.push(k + '=' + encodeURIComponent(q.get(k))); });
    ws = new WebSocket(proto + '//' + location.host + '/voice-live/ws' + (qs.length ? '?' + qs.join('&') : ''));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = function (e) {
      if (typeof e.data === 'string') { try { onEvent(JSON.parse(e.data)); } catch (x) { /* 무시 */ } }
      else playPcm(e.data);
    };
    ws.onclose = function () { if (running) { notice('서버 연결이 끊겼습니다. 다시 시작하세요.'); finish('중단됨'); } };
    ws.onerror = function () { /* onclose 에서 처리 */ };
  }

  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', function () {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'end' })); } catch (e) { /* 무시 */ } }
    else finish('끝남');
  });
})();
</script>
</body>
</html>`;
