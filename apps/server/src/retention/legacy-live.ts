import { lstat, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { addCalendarMonthSeoul } from '../records/time.js';

/** Shared by the worker and the operator CLI. Unknown/unfinished sessions fail closed. */
export async function purgeLegacyLive(dir: string, { now = new Date(), apply = false }: { now?: Date; apply?: boolean } = {}) {
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_CLEANUP_TIME');
  const names = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  const out = { mode: apply ? 'apply' : 'dry-run', targets: 0, oldest: null as string | null, newest: null as string | null, deleted: 0, failed: 0 };
  for (const name of names) {
    if (!/^live-[\w-]+\.json$/.test(name)) continue;
    try {
      const file = path.join(dir, name);
      const before = await lstat(file);
      if (!before.isFile() || now < addCalendarMonthSeoul(before.mtime)) continue;
      const session: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!session || typeof session !== 'object' || Array.isArray(session)) continue;
      const s = session as Record<string, unknown>;
      // Existing files may omit processing, but must have an explicit valid end time.
      // Never infer that an unfinished/processing session stopped from its age.
      if (s.interviewId != null && s.interviewId !== '') continue;
      if (s.processing || typeof s.endedAt !== 'string' || !Number.isFinite(Date.parse(s.endedAt))) continue;
      const current = await lstat(file);
      // LiveSessionStore replaces files atomically. Recheck identity/content metadata before unlink.
      if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs || current.size !== before.size) continue;
      const at = before.mtime.toISOString();
      out.targets++;
      if (out.oldest === null || at < out.oldest) out.oldest = at;
      if (out.newest === null || at > out.newest) out.newest = at;
      if (apply) { await unlink(file); out.deleted++; }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') out.failed++;
    }
  }
  return out;
}
