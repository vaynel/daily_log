import {test} from 'node:test';
import assert from 'node:assert/strict';
const paths=await import('./paths.mjs').catch(()=>({}));
test('native CLI paths accept drive paths but reject UNC, device, ADS and traversal aliases',()=>{
 assert.equal(typeof paths.appDirectory,'function');
 assert.equal(paths.appDirectory('C:\\Users\\한글 사용자\\daily-log-siwc\\account','win32'),'C:\\Users\\한글 사용자\\daily-log-siwc\\account');
 for(const p of ['C:daily-log-siwc','\\\\server\\share\\daily-log-siwc','\\\\?\\C:\\daily-log-siwc','C:\\daily-log-siwc\\x:ads','C:\\daily-log-siwc\\..\\other','C:\\daily-log-siwc\\name.','C:\\daily-log-siwc\\CON']) assert.throws(()=>paths.appDirectory(p,'win32'));
 assert.equal(paths.appDirectory('/workspace/daily-log-siwc/local','linux'),'/workspace/daily-log-siwc/local');
 assert.throws(()=>paths.appDirectory('/workspace/other','linux'));
});
