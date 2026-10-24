/** 음성 대화 시험 화면(단일 HTML). 한 번 시작하면 무음 감지로 자동 전송·재생·재청취를 반복한다. 템플릿 리터럴/백틱을 쓰지 않는다. */
export const VOICE_PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>음성 대화 시험</title>
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
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--warn);outline-offset:2px}
#state{font-weight:600}
#notice{color:var(--warn);min-height:1.5em}
ol{padding-left:1.2em}
.meta{color:var(--muted);font-size:.9rem}
#summary-text{white-space:pre-wrap;margin:0}
fieldset{border:0;padding:0;margin:8px 0}
textarea{width:100%;box-sizing:border-box;font:inherit}
</style>
</head>
<body>
<main>
<h1>음성 대화 시험</h1>
<p class="meta">내부 시험 도구입니다. 시작하면 말이 끝날 때마다 자동으로 전송되고, AI 음성이 끝나면 다시 듣습니다. 끼어들기·동시 발화는 지원하지 않습니다.</p>
<div class="card">
  <button id="start" type="button">대화 시작</button>
  <button id="stop" type="button" class="secondary" disabled>대화 끝내기</button>
  <p>상태: <span id="state" role="status" aria-live="polite">대기 중</span></p>
  <p id="notice" role="alert"></p>
</div>
<div class="card"><h2>대화</h2><ol id="turns" aria-label="대화 기록"></ol></div>
<div class="card" id="summary" hidden><h2>세션 요약</h2><pre id="summary-text" class="meta"></pre></div>
<form class="card" id="feedback" hidden>
  <h2>평가</h2>
  <fieldset><legend>자연스러움 (1 어색함 ~ 5 자연스러움)</legend>
    <label><input type="radio" name="nat" value="1"> 1</label>
    <label><input type="radio" name="nat" value="2"> 2</label>
    <label><input type="radio" name="nat" value="3"> 3</label>
    <label><input type="radio" name="nat" value="4"> 4</label>
    <label><input type="radio" name="nat" value="5"> 5</label>
  </fieldset>
  <fieldset><legend>불편했던 미지원 동작</legend>
    <label><input type="checkbox" name="uns" value="INTERRUPT"> 끼어들기 불가</label>
    <label><input type="checkbox" name="uns" value="OVERLAP"> 동시 발화 불가</label>
    <label><input type="checkbox" name="uns" value="OTHER"> 기타</label>
  </fieldset>
  <label for="note">메모 (500자 이내)</label>
  <textarea id="note" rows="3" maxlength="500"></textarea>
  <p><button id="save" type="submit">평가 저장</button> <span id="saved" role="status"></span></p>
</form>
</main>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var SILENCE_MS = Number(q.get('silenceMs')) || 1200;
  var NO_SPEECH_MS = Number(q.get('noSpeechMs')) || 8000;
  var MIN_SPEECH_MS = Number(q.get('minSpeechMs')) || 300;
  var MAX_UTTER_MS = 45000;
  var THRESHOLD = Number(q.get('rms')) || 0.02;
  var $ = function (id) { return document.getElementById(id); };
  var running = false, sessionId = null, stream = null, ctx = null, analyser = null, buf = null;
  var rec = null, chunks = [], raf = 0, tListen = 0, tFirst = 0, tLast = 0, phase = 'idle', player = null;

  function setState(t) { $('state').textContent = t; }
  function notice(t) { $('notice').textContent = t || ''; }
  function api(path, init) { return fetch('/voice/api' + path, init); }

  function pickMime() {
    var c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (var i = 0; i < c.length; i++) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c[i])) return c[i];
    return '';
  }

  async function start() {
    notice('');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      notice('마이크 권한이 거부되었거나 마이크를 사용할 수 없습니다. 브라우저 설정에서 허용한 뒤 다시 시작하세요.');
      setState('대기 중');
      return;
    }
    var r = await api('/sessions', { method: 'POST' });
    if (!r.ok) { notice('세션을 시작하지 못했습니다.'); stopStream(); return; }
    sessionId = (await r.json()).id;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    var src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024; buf = new Float32Array(analyser.fftSize);
    src.connect(analyser);
    running = true;
    $('start').disabled = true; $('stop').disabled = false;
    $('summary').hidden = true; $('feedback').hidden = true; $('turns').textContent = '';
    listen();
  }

  function rms() {
    analyser.getFloatTimeDomainData(buf);
    var s = 0; for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  function listen() {
    if (!running) return;
    phase = 'listening'; setState('듣는 중');
    chunks = []; tFirst = 0; tLast = 0; tListen = performance.now();
    var mime = pickMime();
    rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start(250);
    tick();
  }

  function tick() {
    if (!running || phase !== 'listening') return;
    var now = performance.now();
    if (rms() > THRESHOLD) { if (!tFirst) tFirst = now; tLast = now; }
    if (!tFirst && now - tListen > NO_SPEECH_MS) { return discard('음성이 들리지 않았습니다(무음). 마이크를 확인하고 말씀해 주세요.'); }
    if (tFirst && (now - tLast > SILENCE_MS || now - tFirst > MAX_UTTER_MS)) { return finish(); }
    raf = setTimeout(tick, 50);
  }

  function stopRec() {
    return new Promise(function (res) {
      if (!rec || rec.state === 'inactive') return res();
      rec.onstop = function () { res(); };
      rec.stop();
    });
  }

  async function discard(msg) {
    phase = 'processing';
    await stopRec();
    notice(msg);
    chunks = [];
    listen();
  }

  async function finish() {
    phase = 'processing';
    var speechMs = tLast - tFirst;
    await stopRec();
    if (speechMs < MIN_SPEECH_MS) { notice('너무 짧은 소리라 보내지 않았습니다. 다시 말씀해 주세요.'); return listen(); }
    var blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    setState('처리 중');
    notice('');
    var res;
    try {
      res = await api('/sessions/' + sessionId + '/turns', { method: 'POST', headers: { 'Content-Type': rec.mimeType || 'audio/webm', 'X-Audio-Duration-Ms': String(Math.round(speechMs)) }, body: blob });
    } catch (e) {
      notice('서버 연결이 끊겼습니다. 연결을 확인하고 다시 시작하세요.');
      return end(false);
    }
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      notice(body.message || '처리하지 못했습니다.');
      if (body.code === 'BUDGET_EXCEEDED' || body.code === 'SESSION_NOT_FOUND' || (body.code || '').indexOf('PRO_') === 0) return end(false);
      return listen();
    }
    var li = document.createElement('li');
    li.textContent = '나: ' + body.turn.userText + ' / AI: ' + body.turn.replyText;
    $('turns').appendChild(li);
    await play(body.audio);
    listen();
  }

  function play(a) {
    phase = 'playing'; setState('AI 음성 재생 중');
    return new Promise(function (resolve) {
      try {
        player = new Audio('data:' + a.mime + ';base64,' + a.base64);
        player.onended = resolve; player.onerror = function () { notice('음성 재생에 실패했습니다.'); resolve(); };
        player.play().catch(function () { notice('음성 재생이 차단되었습니다.'); resolve(); });
      } catch (e) { resolve(); }
    });
  }

  function stopStream() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    if (ctx) ctx.close().catch(function () {});
    stream = null; ctx = null;
  }

  async function end(userInitiated) {
    running = false; phase = 'idle';
    clearTimeout(raf);
    if (player) { player.pause(); player = null; }
    await stopRec();
    stopStream();
    $('start').disabled = false; $('stop').disabled = true;
    setState(userInitiated ? '끝남' : '중단됨');
    if (!sessionId) return;
    var r = await api('/sessions/' + sessionId + '/end', { method: 'POST' });
    if (r.ok) {
      var s = await r.json();
      $('summary-text').textContent = '턴 ' + s.turns.length + ' · STT ' + s.calls.stt + ' / Pro ' + s.calls.pro + ' / TTS ' + s.calls.tts + ' 호출 · 추정 비용 ' + s.estimatedCostKrw.toFixed(1) + '원 (예산 ' + s.budgetKrw + '원)';
      $('summary').hidden = false; $('feedback').hidden = false;
    }
  }

  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', function () { end(true); });
  $('feedback').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var nat = document.querySelector('input[name=nat]:checked');
    if (!nat) { $('saved').textContent = '자연스러움 점수를 선택하세요.'; return; }
    var uns = Array.prototype.map.call(document.querySelectorAll('input[name=uns]:checked'), function (x) { return x.value; });
    var r = await api('/sessions/' + sessionId + '/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ naturalness: Number(nat.value), unsupported: uns, note: $('note').value }) });
    $('saved').textContent = r.ok ? '저장했습니다.' : '저장하지 못했습니다.';
  });
})();
</script>
</body>
</html>`;
