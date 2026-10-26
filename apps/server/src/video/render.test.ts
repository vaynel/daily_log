import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInput, checkOutput, probeVideo, renderVideo, RenderError, type Probe, type RenderDeps } from './render.js';
import { RenderGate } from './renderGate.js';
import { createRenderHandler } from './renderStage.js';
import { NonRetryableError } from '../jobs/queue.js';
import { mockInput, mockOverlay, rm, tmpDir } from './render.testutil.js';

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
const ffprobeJson = (f: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f], { encoding: 'utf8' })) as Probe & { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] };

describe('단일 렌더러 · 세로 영상 합성 (모의 자산, 실제 FFmpeg)', () => {
  let dir: string;
  const input = mockInput([3, 4, 3]);
  const deps = (over: Partial<RenderDeps> = {}): RenderDeps => ({ overlay: mockOverlay(), workDir: path.join(dir, 'work'), ...over });
  beforeAll(() => { dir = tmpDir(); });
  afterAll(() => rm(dir));

  it('AC-1/AC-3 완성 파일은 9:16, 180초 이하, H.264 영상 1개+AAC 음성 1개뿐(음악 트랙 없음)', async () => {
    const out = path.join(dir, 'a', 'video.mp4');
    const r = await renderVideo(deps(), input, out);
    const p = ffprobeJson(out);
    const v = p.streams.filter((s) => s.codec_type === 'video'), a = p.streams.filter((s) => s.codec_type === 'audio');
    expect(p.streams).toHaveLength(2);
    expect(v[0]).toMatchObject({ codec_name: 'h264', width: 720, height: 1280 });
    expect(a[0]!.codec_name).toBe('aac');
    expect(Number(p.format.duration)).toBeLessThanOrEqual(180);
    expect(Math.abs(Number(p.format.duration) - input.totalSec)).toBeLessThan(0.6);
    expect(r.overlays).toBeGreaterThan(0);
    expect(readdirSync(path.dirname(out)).filter((f) => f.endsWith('.part.mp4'))).toEqual([]);
  }, 120_000);

  it('AC-1 경계: 합쳐서 180초인 입력도 180초 이하 9:16 으로 끝난다', async () => {
    const big = mockInput([59, 60, 59]); // 177 + 1.0 사이 간격 = 179
    const out = path.join(dir, 'big', 'video.mp4');
    await renderVideo(deps(), big, out);
    expect(checkOutput(await probeVideo(out), big.totalSec)).toEqual([]);
    expect(Number(ffprobeJson(out).format.duration)).toBeLessThanOrEqual(180);
  }, 240_000);

  it('180초를 넘는 입력은 렌더 전에 거절하고 이전 결과를 그대로 둔다', async () => {
    const out = path.join(dir, 'over', 'video.mp4');
    await renderVideo(deps(), input, out);
    const before = sha(out);
    await expect(renderVideo(deps(), { ...input, totalSec: 181 }, out)).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sha(out)).toBe(before);
  }, 120_000);

  it('checkOutput: 음악 트랙·4:3·180초 초과·길이 불일치를 잡는다', () => {
    const ok: Probe = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280, pix_fmt: 'yuv420p' }, { codec_type: 'audio', codec_name: 'aac' }], format: { duration: '10.0' } };
    expect(checkOutput(ok, 10)).toEqual([]);
    expect(checkOutput({ ...ok, streams: [...ok.streams, { codec_type: 'audio', codec_name: 'aac' }] }, 10)).toContain('STREAM_LAYOUT');
    expect(checkOutput({ ...ok, streams: [{ ...ok.streams[0]!, width: 960, height: 720 }, ok.streams[1]!] }, 10)).toContain('NOT_9_16');
    expect(checkOutput({ ...ok, format: { duration: '180.5' } }, 180)).toContain('OVER_MAX_SEC');
    expect(checkOutput(ok, 20)).toContain('DURATION_MISMATCH');
    expect(() => checkInput({ ...input, narration: input.narration.slice(1) })).toThrow(RenderError);
  });

  it('AC-3 렌더 코드는 네트워크·AI 영상 API 를 부르지 않는다(호출·의존성 검사)', () => {
    for (const f of ['render.ts', 'renderStage.ts', 'renderGate.ts', 'overlay.ts']) {
      const src = readFileSync(path.join(import.meta.dirname, f), 'utf8');
      expect(src, f).not.toMatch(/\bfetch\s*\(|https?:\/\/|googleapis|veo|runway|sora|amix|anullsrc|music/i);
    }
  });

  it('중간 결과 재사용: 같은 자막·확대 오버레이는 다시 그리지 않는다', async () => {
    const calls = { n: 0 };
    const d = deps({ overlay: mockOverlay(calls), workDir: path.join(dir, 'work-reuse') });
    const first = await renderVideo(d, input, path.join(dir, 'reuse', 'v.mp4'));
    const drawn = calls.n;
    expect(drawn).toBeGreaterThan(0);
    const second = await renderVideo(d, input, path.join(dir, 'reuse', 'v.mp4'));
    expect(calls.n).toBe(drawn);
    expect(second.overlaysReused).toBe(first.overlays);
  }, 120_000);

  it('AC-2 동시에 여러 요청이 와도 렌더는 한 번에 하나만 실행된다', async () => {
    const gate = new RenderGate();
    let running = 0, peak = 0;
    const tracked: RenderDeps['overlay'] = async (h) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 30)); running--; return mockOverlay()(h); };
    const jobs = [0, 1, 2, 3].map((k) => gate.run(async () => {
      // 게이트 안쪽 구간 전체에서 동시 실행 수를 센다.
      const start = Date.now();
      const r = await renderVideo(deps({ overlay: tracked, workDir: path.join(dir, `work-c${k}`) }), mockInput([2, 2]), path.join(dir, 'conc', `v${k}.mp4`));
      return { r, start, end: Date.now() };
    }));
    const done = await Promise.all(jobs);
    expect(gate.peak).toBe(1);
    expect(peak).toBe(1);
    const spans = done.map((d) => [d.start, d.end]).sort((a, b) => a![0]! - b![0]!);
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]!).toBeGreaterThanOrEqual(spans[i - 1]![1]!); // 구간이 겹치지 않음
    for (let k = 0; k < 4; k++) expect(existsSync(path.join(dir, 'conc', `v${k}.mp4`))).toBe(true);
  }, 240_000);

  it('AC-2 앞 렌더가 실패해도 대기 중인 다음 요청은 이어서 실행된다', async () => {
    const gate = new RenderGate();
    const failing = gate.run(async () => { throw new Error('boom'); });
    const next = gate.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(gate.active).toBe(0);
  });

  describe('AC-4 장애: 이전 결과와 원본 기록 보존', () => {
    const records = { interview: '오늘 하루 원본 기록 — 렌더러가 건드리면 안 됨' };
    const setup = async (name: string) => {
      const out = path.join(dir, name, 'video.mp4');
      await renderVideo(deps(), input, out);
      const recFile = path.join(dir, name, 'record.json');
      writeFileSync(recFile, JSON.stringify(records));
      return { out, before: sha(out), recFile, recBefore: sha(recFile) };
    };
    const intact = (s: Awaited<ReturnType<typeof setup>>) => {
      expect(sha(s.out)).toBe(s.before);
      expect(sha(s.recFile)).toBe(s.recBefore);
      expect(readdirSync(path.dirname(s.out)).filter((f) => f.includes('.part'))).toEqual([]);
    };

    it('디스크 여유 부족이면 시작하지 않고 DISK_LOW', async () => {
      const s = await setup('low');
      await expect(renderVideo(deps({ freeBytes: async () => 1024 }), input, s.out)).rejects.toMatchObject({ code: 'DISK_LOW' });
      intact(s);
    }, 120_000);

    it('렌더 도중 쓰기 공간이 바닥나면(파일 크기 상한 초과) DISK_FULL, 임시 파일 정리', async () => {
      const s = await setup('full');
      await expect(renderVideo(deps({ fileSizeLimitKb: 8 }), input, s.out)).rejects.toMatchObject({ code: 'DISK_FULL' });
      intact(s);
    }, 120_000);

    it('렌더가 시간 제한으로 중단되면(SIGKILL) TIMEOUT, 이전 결과 보존', async () => {
      const s = await setup('timeout');
      await expect(renderVideo(deps({ timeoutMs: 1 }), input, s.out)).rejects.toMatchObject({ code: 'TIMEOUT' });
      intact(s);
    }, 120_000);

    it('오버레이 그리기 실패·FFmpeg 없음도 이전 결과를 바꾸지 않는다', async () => {
      const s = await setup('misc');
      await expect(renderVideo(deps({ overlay: async () => { throw new Error('x'); }, workDir: path.join(dir, 'work-bad') }), input, s.out)).rejects.toMatchObject({ code: 'OVERLAY_FAILED' });
      await expect(renderVideo(deps({ ffmpeg: '/nonexistent/ffmpeg' }), input, s.out)).rejects.toBeInstanceOf(RenderError);
      intact(s);
    }, 120_000);

    it('이전 중단이 남긴 임시 파일은 다음 렌더 시작 때 정리되고 새 결과가 원자적으로 교체한다', async () => {
      const s = await setup('stale');
      writeFileSync(path.join(path.dirname(s.out), '.video.mp4.1.x.part.mp4'), 'partial');
      const r = await renderVideo(deps(), mockInput([2, 2]), s.out);
      expect(existsSync(path.join(path.dirname(s.out), '.video.mp4.1.x.part.mp4'))).toBe(false);
      expect(sha(s.out)).toBe(r.sha256);
      expect(r.sha256).not.toBe(s.before);
    }, 120_000);
  });

  describe('큐 단계 처리기', () => {
    it('입력이 없으면 재시도 없는 실패(NonRetryable), 렌더 중에는 임대 연장을 반복 호출한다', async () => {
      const out = path.join(dir, 'stage', 'v.mp4');
      let beats = 0;
      const ctx = (): Parameters<ReturnType<typeof createRenderHandler>['execute']>[0] => ({ jobId: 'j', subjectId: 's', stage: 'render', attempt: 1, externalRequestId: 'x', results: {}, heartbeat: async () => { beats++; return true; } });
      const slow: RenderDeps['overlay'] = async (h) => { await new Promise((r) => setTimeout(r, 120)); return mockOverlay()(h); };
      const h = createRenderHandler({ gate: new RenderGate(), render: deps({ overlay: slow, workDir: path.join(dir, 'work-stage') }), loadInput: async (id) => (id === 's' ? input : null), outFile: () => out, heartbeatMs: 40 });
      const res = await h.execute(ctx());
      expect(beats).toBeGreaterThanOrEqual(3);
      const rendered = res.result as { file: string; sha256: string };
      expect(rendered.file).toBe('v.j.q0.mp4');
      expect(rendered.sha256).toBe(sha(path.join(path.dirname(out), rendered.file)));
      expect(existsSync(out)).toBe(false); // legacy target is not overwritten by a new generation
      const none = createRenderHandler({ gate: new RenderGate(), render: deps(), loadInput: async () => null, outFile: () => out, heartbeatMs: 40 });
      await expect(none.execute(ctx())).rejects.toBeInstanceOf(NonRetryableError);
    }, 120_000);
  });
});
