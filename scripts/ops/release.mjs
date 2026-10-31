// This changes only a release symlink. It never edits DNS/nginx/services or runs migrations.
import { readFileSync, realpathSync, symlinkSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
const [action, rootArg, commit] = process.argv.slice(2);
let status = 'WAITING_APPROVAL';
try {
  if (!['status','switch'].includes(action) || !rootArg || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('INVALID_ARGUMENTS');
  const root = realpathSync(rootArg);
  const release = join(root,'releases',commit);
  if (realpathSync(release) !== resolve(release)) throw new Error('RELEASE_SYMLINK_REJECTED');
  let approval;
  try { approval = JSON.parse(readFileSync(join(root,'approval.json'),'utf8')); } catch { throw new Error('WAITING_APPROVAL'); }
  const now = Date.now();
  if (approval.commit !== commit || !approval.administrator?.trim() || !Number.isFinite(Date.parse(approval.approvedAt)) || Date.parse(approval.approvedAt)>now || !(Date.parse(approval.expiresAt)>now)) throw new Error('WAITING_APPROVAL');
  if (approval.backupVerified !== true || !['dns','https','google','android','pc'].every(k=>approval.externalChecks?.[k]===true)) throw new Error('WAITING_EXTERNAL_CHECKS');
  status='READY_FOR_ADMIN_SWITCH';
  if (action==='switch') {
    const temp=join(root,`.current-${process.pid}`);
    try { symlinkSync(`releases/${commit}`,temp); renameSync(temp,join(root,'current')); }
    finally { try { unlinkSync(temp); } catch { /* renamed or never created */ } }
    status='SWITCHED_PENDING_VERIFICATION';
  }
  console.log(JSON.stringify({status,commit,deployed:false,message:'개통 미완료 — 관리자 검증 대기'}));
} catch (error) {
  console.log(JSON.stringify({status: ['WAITING_APPROVAL','WAITING_EXTERNAL_CHECKS'].includes(error.message) ? error.message : 'BLOCKED',deployed:false,message:'개통 미완료'}));
  process.exitCode=2;
}
