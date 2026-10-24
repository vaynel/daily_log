#!/usr/bin/env node
// PM 실측 스크립트(TASK-73 → TASK-9): 녹음된 한국어 샘플을 N턴 보내 지연·호출 수·추정 비용 요약을 출력한다.
// 출력은 숫자 값만이다. 키·발화·답변 원문은 출력하지 않는다(서버가 응답에 담아도 이 스크립트는 읽지 않는다).
// 사용: node scripts/voice-measure.mjs --base https://daily.log2u.me --file sample.webm --turns 5 [--duration-ms 4000] [--mime audio/webm]
// 실제 유료 API는 서버(배포본)가 호출한다. 이 스크립트는 예산 상한(서버 DAILY_LOG_VOICE_BUDGET_KRW) 안에서만 진행되고, 402를 받으면 멈춘다.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** 세션 JSON(서버 SessionRecord)에서 값만 요약한다. */
export function summarize(session) {
  const total = session.turns.map((t) => t.latencyMs.total).sort((a, b) => a - b);
  const avg = (f) => (session.turns.length ? Math.round(session.turns.reduce((s, t) => s + f(t), 0) / session.turns.length) : null);
  return {
    turns: session.turns.length,
    rejected: session.rejected.length,
    calls: session.calls,
    latencyMs: {
      sttAvg: avg((t) => t.latencyMs.stt), proAvg: avg((t) => t.latencyMs.pro), ttsAvg: avg((t) => t.latencyMs.tts),
      totalAvg: avg((t) => t.latencyMs.total), totalP50: percentile(total, 50), totalMax: total.at(-1) ?? null,
    },
    estimatedCostKrw: Math.round(session.estimatedCostKrw * 100) / 100,
    costPerTurnKrw: session.turns.length ? Math.round((session.estimatedCostKrw / session.turns.length) * 100) / 100 : null,
    budgetKrw: session.budgetKrw,
    stoppedReason: session.stoppedReason,
    note: session.pricingNote,
  };
}

async function main() {
  const a = process.argv.slice(2);
  const v = (f, d) => { const i = a.indexOf(f); return i < 0 ? d : a[i + 1]; };
  const base = v('--base'); const file = v('--file'); const n = Number(v('--turns', '5'));
  if (!base || !file || !Number.isInteger(n) || n < 1 || n > 50) throw new Error('사용: --base URL --file 오디오 --turns 1..50 [--duration-ms N] [--mime audio/webm]');
  const audio = await readFile(file);
  const headers = { 'Content-Type': v('--mime', 'audio/webm'), 'X-Audio-Duration-Ms': String(v('--duration-ms', '4000')) };
  const id = (await (await fetch(`${base}/voice/api/sessions`, { method: 'POST' })).json()).id;
  const codes = [];
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${base}/voice/api/sessions/${id}/turns`, { method: 'POST', headers, body: audio });
    if (!r.ok) { codes.push((await r.json().catch(() => ({}))).code ?? `HTTP_${r.status}`); if (r.status === 402 || r.status === 404) break; }
    else await r.arrayBuffer();
  }
  const session = await (await fetch(`${base}/voice/api/sessions/${id}/end`, { method: 'POST' })).json();
  console.log(JSON.stringify({ sessionId: id, requestedTurns: n, failureCodes: codes, ...summarize(session) }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`중단: ${e.message}`); process.exitCode = 1; });
