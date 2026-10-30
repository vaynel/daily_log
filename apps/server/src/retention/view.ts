/** 서버 사본 상태 문구. "전체 사본이 삭제됐다"고 말하지 않는다: 서버 삭제와 Drive 백업·완성 영상 보존을 항상 구분해서 알린다. */
export type ServerCopy = 'PRESENT' | 'TRASHED' | 'CLEANED' | 'PURGED';

export const BACKUP_KEPT = 'Drive 백업과 완성 영상은 삭제되지 않고 그대로 유지됩니다.';

const BLOCK_LABEL: Record<string, string> = {
  BACKUP_NOT_CURRENT: '최신 내용의 Drive 백업이 아직 확인되지 않았습니다',
  SOURCE_INCOMPLETE: '백업할 원본 일부를 찾지 못했습니다',
  VERIFY_MISMATCH: 'Drive 백업 파일을 확인했지만 내용이 일치하지 않습니다',
  DRIVE_UNREACHABLE: 'Drive 에 연결해 백업을 확인할 수 없습니다',
  DRIVE_NOT_CONNECTED: 'Google Drive 가 연결되어 있지 않습니다',
  DRIVE_AUTH_EXPIRED: 'Google Drive 연결이 만료되었습니다',
  AUTH_EXPIRED: 'Google Drive 연결이 만료되었습니다',
  BACKUP_INCOMPLETE: '최신 내용의 Drive 백업이 아직 확인되지 않았습니다',
  JOB_IN_PROGRESS: '처리 중인 작업이 끝나기를 기다리는 중입니다',
  CHANGED_DURING_CHECK: '확인하는 사이 기록이 바뀌어 다시 확인합니다',
};

export function blockLabel(code: string | null): string | null {
  if (!code) return null;
  return BLOCK_LABEL[code] ?? '백업을 확인하지 못했습니다';
}

const ymd = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

export function retentionNotice(r: { serverCopy: ServerCopy; trashPurgeAt: Date | null; cleanupDueAt: Date; cleanupBlockedReason: string | null }, now: Date) {
  const base = { serverCopy: r.serverCopy, cleanupDueAt: r.cleanupDueAt.toISOString(), trashPurgeAt: r.trashPurgeAt?.toISOString() ?? null, backupKept: true as const };
  switch (r.serverCopy) {
    case 'TRASHED': return { ...base, cleanupPending: null, message: `휴지통에 있습니다. ${ymd(r.trashPurgeAt!)}까지 복구할 수 있고, 그 뒤 서버 사본이 삭제됩니다. ${BACKUP_KEPT}` };
    case 'PURGED': return { ...base, cleanupPending: null, message: `서버 사본이 삭제되었습니다. ${BACKUP_KEPT}` };
    case 'CLEANED': return { ...base, cleanupPending: null, message: `한 달이 지나 서버의 텍스트·첨부 사본을 정리했습니다. ${BACKUP_KEPT}` };
    case 'PRESENT': {
      const label = now >= r.cleanupDueAt ? blockLabel(r.cleanupBlockedReason) : null;
      return {
        ...base,
        cleanupPending: label,
        message: label ? `한 달 보관이 지났지만 서버 사본을 그대로 둡니다: ${label}.` : null,
      };
    }
  }
}
