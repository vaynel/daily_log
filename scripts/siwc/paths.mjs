import {posix,win32} from 'node:path';
export function appDirectory(dir,platform=process.platform) {
 const path=platform==='win32'?win32:posix;
 if(typeof dir!=='string' || !path.isAbsolute(dir)) throw Error('APP_DIRECTORY_REQUIRED');
 if(platform==='win32') {
  if(!/^[A-Za-z]:\\/.test(dir) || dir.includes('/') || /[:<>"|?*]/.test(dir.slice(2)) || [...dir].some(c=>c.charCodeAt(0)<32)) throw Error('APP_DIRECTORY_REQUIRED');
  const parts=dir.slice(3).split('\\');
  if(parts.some(p=>!p || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw Error('APP_DIRECTORY_REQUIRED');
 }
 if(!dir.split(path.sep).includes('daily-log-siwc') || dir.split(path.sep).some(p=>p==='.' || p==='..')) throw Error('APP_DIRECTORY_REQUIRED');
 return path.normalize(dir);
}
