import type { AudioView, PipelineState } from '../records/store.js';

export interface AudioNotice {
  code: 'AUDIO_EXPIRED';
  /** 화면에 표시하는 문장. */
  message: string;
  /** 음성(읽어 주기)용 짧은 문장. */
  speech: string;
  expiredCount: number;
  preserved: { items: number; attachments: number };
  backup: PipelineState['backup'];
}

const BACKUP_TEXT: Record<PipelineState['backup'], string> = {
  NONE: 'Drive 백업은 아직 시작되지 않았습니다. 백업이 확인되기 전에는 서버의 글과 첨부가 정리되지 않고 유지됩니다.',
  PENDING: 'Drive 백업이 진행 대기 중입니다. 백업이 확인되기 전에는 서버의 글과 첨부가 정리되지 않고 유지됩니다.',
  VERIFIED: 'Drive 백업이 확인되었습니다. 서버의 글과 첨부는 보관 기간이 지나면 정리될 수 있고 백업 사본은 남습니다.',
  FAILED: 'Drive 백업에 실패했습니다. 백업이 확인되기 전에는 서버의 글과 첨부가 정리되지 않고 유지됩니다.',
};

/**
 * 만료된 음성 구간이 있으면 재개 불가 사유와 실제 보존 상태를 안내한다. 없으면 null.
 * 만료된 음성은 복구된 것처럼 말하지 않고, 보존 건수와 백업 상태는 실제 값만 쓴다.
 */
export function describeAudioExpiry(audio: AudioView[], preserved: { items: number; attachments: number }, backup: PipelineState['backup'] | undefined): AudioNotice | null {
  const expired = audio.filter((a) => a.status === 'EXPIRED');
  if (!expired.length) return null;
  const b = backup ?? 'NONE';
  const keep = preserved.items || preserved.attachments
    ? `저장된 글 ${preserved.items}개와 첨부 ${preserved.attachments}개는 그대로 남아 있습니다.`
    : '이 기록에 남아 있는 글과 첨부는 없습니다.';
  return {
    code: 'AUDIO_EXPIRED',
    message: `변환되지 않았거나 중간에 끊긴 음성 ${expired.length}구간이 보관 기간(한 달)이 지나 삭제되어, 이 부분의 음성은 이어서 들을 수 없습니다. ${keep} ${BACKUP_TEXT[b]} 음성 자체는 Drive 백업 대상이 아닙니다.`,
    speech: `보관 기간 한 달이 지나 이전 음성 ${expired.length}구간은 이어갈 수 없습니다. ${keep}`,
    expiredCount: expired.length,
    preserved,
    backup: b,
  };
}
