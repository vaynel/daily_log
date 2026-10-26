import { classifyExclusion } from '../briefing/exclusion.js';

/**
 * 이미지 생성 API 입력 구성(TASK-23 D22-01).
 * 외부로 나가는 것은 (1) 글자 없는 장면 설명, (2) 메타데이터를 제거한 참조 사진, (3) 캐릭터 기준 시트뿐이다.
 * 대사·근거 id·기록 원문은 보내지 않고, 공개 제외 대상(정치·비방·뒷담화·형사)으로 분류되는 설명 문장은 뺀다.
 */

export const BACKGROUND_STYLE =
  '색연필 스케치 그림체: 종이 질감, 연필 해칭, 파스텔 색감. 사진을 그대로 쓰지 말고 같은 장소의 구조와 특징(배치·큰 물체·창/문·공간 깊이)을 손으로 그린 듯 다시 그린다.';
export const NO_TEXT_RULE = '그림 안에 글자·숫자·간판 문구·로고·실제 상표·화면 속 문장을 넣지 않는다. 사람 얼굴과 개인 식별 정보는 단순한 낙서 형태로만 그린다.';
export const CHARACTER_STYLE = '굵은 낙서선과 흰 바탕. 배경이 없는 캐릭터만 그린다.';

export type ExcludedReason = 'EXCLUDED_ALL' | 'EMPTY';

/** 설명을 문장으로 나눠 제외 분류에 걸리는 문장을 뺀다. 남는 것이 없으면 실패. */
export function sanitizeVisual(visual: string): { ok: true; text: string; removed: number } | { ok: false; code: ExcludedReason } {
  const sentences = visual.replace(/\s+/g, ' ').trim().split(/(?<=[.!?。])\s+/).filter(Boolean);
  if (!sentences.length) return { ok: false, code: 'EMPTY' };
  const kept = sentences.filter((s) => classifyExclusion(s) === null);
  if (!kept.length) return { ok: false, code: 'EXCLUDED_ALL' };
  return { ok: true, text: kept.join(' '), removed: sentences.length - kept.length };
}

export interface ImageRef { mime: string; data: Buffer; role: 'PHOTO' | 'CHARACTER_SHEET' }
export interface ImageRequest { prompt: string; references: ImageRef[]; aspectRatio: '9:16' | '1:1' }

export function backgroundRequest(visual: string, photo: Buffer | null): { ok: true; request: ImageRequest; removed: number } | { ok: false; code: ExcludedReason } {
  const s = sanitizeVisual(visual);
  if (!s.ok) return s;
  const prompt = [
    '세로 9:16 일기 영상의 배경 한 장을 그린다.',
    BACKGROUND_STYLE,
    photo ? '첨부한 참조 사진의 장소 구조를 따라 그린다.' : '참조 사진 없이 아래 설명만으로 그린다.',
    `장면 설명: ${s.text}`,
    NO_TEXT_RULE,
    '캐릭터는 그리지 않는다(캐릭터는 별도 레이어로 얹는다).',
  ].join('\n');
  return { ok: true, removed: s.removed, request: { prompt, aspectRatio: '9:16', references: photo ? [{ mime: 'image/jpeg', data: photo, role: 'PHOTO' }] : [] } };
}

export interface PoseSpec { expression: string; action: string }

export function characterRequest(pose: PoseSpec, sheet: Buffer): ImageRequest {
  return {
    aspectRatio: '1:1',
    references: [{ mime: 'image/jpeg', data: sheet, role: 'CHARACTER_SHEET' }],
    prompt: [
      '첨부한 기준 시트의 캐릭터 A와 완전히 같은 인물(동그란 흰 머리, 넓게 벌어진 점 눈, 삼각 입, 머리카락 한 가닥, 회색 후드, 흰 바지)을 그린다.',
      `표정: ${pose.expression}. 동작: ${pose.action}.`,
      CHARACTER_STYLE,
      NO_TEXT_RULE,
      '의상·비율·선 굵기는 기준 시트에서 바꾸지 않는다.',
    ].join('\n'),
  };
}
