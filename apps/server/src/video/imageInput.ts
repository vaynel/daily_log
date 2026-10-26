import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { classifyExclusion } from '../briefing/exclusion.js';

const run = promisify(execFile);

/**
 * 이미지 생성 API로 나가는 입력 정리(TASK-23 D22-01). 외부로 나가는 것은 (1) 메타데이터를 벗긴 사진과
 * (2) 공개 제외 요소를 뺀 시각 설명뿐이다. 제외 기준은 TASK-20/22 의 분류(classifyExclusion)와 같은 것을 쓴다.
 */

/** 시각 설명을 문장 단위로 나누어 제외 분류에 걸리는 문장과 추가 제외 문구가 든 문장을 뺀다. */
export function sanitizeVisual(visual: string, extraExcluded: string[] = []): { text: string; removed: number } {
  const sentences = visual.split(/(?<=[.!?。])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const extras = extraExcluded.map((e) => e.trim()).filter((e) => e.length >= 2);
  const kept = sentences.filter((s) => classifyExclusion(s) === null && !extras.some((e) => s.includes(e)));
  return { text: kept.join(' '), removed: sentences.length - kept.length };
}

/**
 * 사진의 EXIF·GPS 등 메타데이터를 제거한 JPEG 로 다시 인코딩한다(원본 파일은 건드리지 않는다).
 * 위치·촬영 기기 정보가 외부 이미지 API 로 나가지 않게 한다.
 * 휴대폰 JPEG 처럼 뒤에 부가 데이터(두 번째 이미지 등)가 붙은 파일도 첫 프레임 하나만 쓴다(-frames:v 1).
 */
export async function stripPhoto(photo: Buffer, ffmpeg = 'ffmpeg'): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dl-strip-'));
  try {
    const src = path.join(dir, 'in.bin');
    const dst = path.join(dir, 'out.jpg');
    await writeFile(src, photo);
    await run(ffmpeg, ['-v', 'error', '-y', '-i', src, '-map_metadata', '-1', '-fflags', '+bitexact', '-vf', 'scale=min(1280\\,iw):-2', '-frames:v', '1', '-q:v', '3', dst]);
    return await readFile(dst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const STYLE_BACKGROUND =
  '사진을 바탕으로 한 색연필 스케치. 종이 질감, 연필 해칭, 파스텔 색감. 사진의 장소 구조(건물·가구·창·길의 배치와 특징적인 물건)를 같은 위치와 비율로 유지하되 사진처럼 보이지 않게 그린다. 세로 9:16.';
export const RULES_NO_TEXT =
  '그림 안에 글자·숫자·간판 문구·실제 상표·로고를 넣지 않는다. 사진에 간판·입간판·현수막·메뉴판·표지판·전화번호가 있으면 그 판은 글자 없이 비어 있는 빈 판(무늬 없는 색면)으로만 그린다. 상단 간판 영역도 마찬가지다. 사람 얼굴은 단순한 낙서선으로만 그린다. 캐릭터는 그리지 않는다.';
/** 글자가 남았다고 의심돼 한 번 더 그릴 때 덧붙이는 지시. */
export const RULES_RETRY_NO_TEXT = '이전 결과에 읽을 수 있는 글자가 남아 있었다. 모든 간판·표지·메뉴·상표 면을 글자 없는 빈 판으로 바꾸고, 글자처럼 보이는 선도 그리지 않는다.';
export const STYLE_CHARACTER =
  '첨부한 기준 시트의 캐릭터 A와 같은 인물: 동그란 흰 머리, 넓게 벌어진 점 눈, 삼각 입, 머리카락 한 가닥, 회색 후드, 흰 바지, 굵은 낙서선, 흰 바탕. 외형과 의상을 바꾸지 않는다. 그림 안에 글자·상표를 넣지 않는다. 세로 9:16.';

export function backgroundPrompt(visual: string, retryNoText = false): string {
  return [STYLE_BACKGROUND, RULES_NO_TEXT, retryNoText ? RULES_RETRY_NO_TEXT : '', visual ? `장면 설명: ${visual}` : ''].filter(Boolean).join('\n');
}
export function posePrompt(expression: string, action: string): string {
  return [STYLE_CHARACTER, `표정: ${expression}. 동작: ${action}.`].join('\n');
}
