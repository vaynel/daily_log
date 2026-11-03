// Independent QA reproduction; uses only synthetic inputs under /workspace/data.
import { checkNginx, checkWorker } from './preflight.mjs';
import { mkdirSync, writeFileSync, symlinkSync, readlinkSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const https = body => `server { listen 443 ssl; ${body} }`;
const worker = (restart='on-failure', delay='10s', limit='0') => `LoadState=loaded\nRestart=${restart}\nRestartUSec=${delay}\nStartLimitIntervalUSec=${limit}\n`;
let failures = 0, total = 0;
function verify(name, expected, actual) {
  total++;
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: expected=${expected} actual=${actual}`);
}
for (const value of ['1m','10m','0','10486784','11m','11M','11264k','11264K','10486785','1g','1G']) {
  const expected = ['1m','10m','0','10486784'].includes(value) ? 'FAIL' : 'PASS';
  verify(`nginx ${value}`, expected, checkNginx(https(`client_max_body_size ${value};`)).result);
}
for (const [name, input, expected] of [
  ['comment-only', '# client_max_body_size 11m;\n', 'FAIL'],
  ['trailing-comment', 'client_max_body_size 11M; # client_max_body_size 1m;\n', 'PASS'],
  ['location-override', 'client_max_body_size 11m; location /api { client_max_body_size 1M; }', 'FAIL'],
  ['location-larger', 'client_max_body_size 11m; location /api { client_max_body_size 12M; }', 'PASS'],
  ['quoted-hash-braces', 'client_max_body_size 11m; location ~ "a{1,2}#b" { }', 'PASS'],
]) verify(name, expected, checkNginx(https(input)).result);
verify('http-inheritance', 'PASS', checkNginx('http { client_max_body_size 11264K; server { listen 443 ssl; location /api {} } }').result);
for (const [name, input, expected] of [
  ['normal', worker(), 'PASS'], ['always',worker('always','1ms','0us'),'PASS'],
  ['restart-no',worker('no'),'FAIL'], ['delay-zero',worker('always','0'),'FAIL'],
  ['start-limit',worker('always','10s','10s'),'FAIL'],
  ['restart-uppercase',worker('ON-FAILURE'),'FAIL'], ['duration-uppercase',worker('always','10S'),'FAIL'],
  ['CRLF',worker().replaceAll('\n','\r\n'),'PASS'],
]) verify(`worker ${name}`, expected, checkWorker(input).result);
mkdirSync('/workspace/data/task133', {recursive:true});
const root = mkdtempSync('/workspace/data/task133/release-');
const commit = 'e7613e0652cc864c5da0e1b30096fc449021f415';
mkdirSync(join(root,'releases',commit),{recursive:true});
symlinkSync('releases/previous',join(root,'current'));
writeFileSync(join(root,'approval.json'),JSON.stringify({commit,administrator:'SYNTHETIC QA ONLY',approvedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),backupVerified:true,externalChecks:{dns:true,https:true,google:true,android:true,pc:true}}));
writeFileSync(join(root,'worker.txt'),worker());
for (const value of ['1g','1G','1024m']) {
  writeFileSync(join(root,'nginx.conf'),https(`client_max_body_size ${value};`));
  const r=spawnSync(process.execPath,['scripts/ops/release.mjs','switch',root,commit,'--nginx-config',join(root,'nginx.conf'),'--worker-properties',join(root,'worker.txt')],{encoding:'utf8'});
  const result=JSON.parse(r.stdout);
  console.log(`release ${value}: exit=${r.status} status=${result.status} current=${readlinkSync(join(root,'current'))}`);
  verify(`release ${value}`, 'SWITCHED_PENDING_VERIFICATION',result.status);
}
console.log(`Independent assertions: ${total-failures}/${total} PASS; ${failures} FAIL`);
process.exitCode = failures ? 1 : 0;
