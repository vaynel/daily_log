import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkNginx, checkWorker, runPreflight } from './preflight.mjs';
const https = body => `server { listen 443 ssl; ${body} }`;
const worker = (restart='on-failure', delay='10s', limit='0') => `Restart=${restart}\nRestartUSec=${delay}\nStartLimitIntervalUSec=${limit}\n`;

test('nginx rejects missing/small/unlimited limits and accepts sizes strictly above photoBytes + 1024', () => {
  for (const value of ['', '1m', '10m', '0', '10486784', 'nonsense']) {
    assert.equal(checkNginx(https(value ? `client_max_body_size ${value};` : '')).result, 'FAIL', value);
  }
  for (const value of ['11m', '11M', '11264k', '10486785']) {
    assert.equal(checkNginx(https(`client_max_body_size ${value};`)).result, 'PASS', value);
  }
});

test('nginx respects comments, quoted braces, HTTP inheritance and nested location overrides', () => {
  assert.equal(checkNginx(https('# client_max_body_size 11m;\n')).result, 'FAIL');
  assert.equal(checkNginx(https('client_max_body_size 11m; # client_max_body_size 1m;\nlocation /api { client_max_body_size 1m; }')).result, 'FAIL');
  assert.equal(checkNginx(https('client_max_body_size 11m; location /api { location /api/upload { client_max_body_size 0; } }')).result, 'FAIL');
  assert.equal(checkNginx(https('client_max_body_size 11m; location ~ "foo{1,2}#bar" { proxy_pass http://localhost; }')).result, 'PASS');
  assert.equal(checkNginx('http { client_max_body_size 11m; server { listen 443 ssl; location /api {} } }').result, 'PASS');
  assert.equal(checkNginx('server { listen 80; client_max_body_size 1m; }'+https('client_max_body_size 11m;')).result, 'PASS');
  assert.equal(checkNginx(https('client_max_body_size 11m;')+https('client_max_body_size 10m;')).result, 'FAIL');
  assert.equal(checkNginx(https('location / { client_max_body_size 11m; }')).result, 'FAIL');
});

test('nginx cannot claim PASS for unresolved includes, absent HTTPS, or malformed config', () => {
  for (const config of [https('client_max_body_size 11m; include other.conf;'), 'include other.conf;', 'server { listen 80; }', 'server { listen 443 ssl;']) {
    assert.equal(checkNginx(config).result, 'NOT_RUN');
  }
  assert.equal(checkNginx(https('client_max_body_size 1m; include other.conf;')).result, 'FAIL');
});

test('worker requires restart policy, positive finite delay and disabled start limit', () => {
  for (const restart of ['on-failure','always']) for (const delay of ['10s','100ms','1min 2s','1000000','1us']) {
    assert.equal(checkWorker(worker(restart,delay)).result, 'PASS');
  }
  for (const input of [worker('no'), worker('on-failure','0'),worker('on-failure','0us'),worker('always','infinity'),worker('always','oops'),worker('always','10s','10s'),worker('always','10s','infinity'),'', 'Restart=always',worker()+'Restart=no\n',worker()+'LoadState=not-found\n']) {
    assert.equal(checkWorker(input).result, 'FAIL');
  }
  assert.equal(checkWorker(worker('always','10s','0us')).result, 'PASS');
});

test('CLI returns JSON and exit 1 for FAIL, missing files NOT_RUN; permission denied never leaks file contents', () => {
  const root = mkdtempSync('/workspace/data/task30/preflight-cli-');
  const nginx = join(root,'nginx.conf'), unit = join(root,'worker.txt');
  const args = ['scripts/ops/preflight.mjs','--nginx-config',nginx,'--worker-properties',unit];
  try {
    let r = spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(r.status,0); assert.deepEqual(JSON.parse(r.stdout).checks.map(c=>c.result),['NOT_RUN','NOT_RUN']);
    writeFileSync(nginx,https('client_max_body_size 11m;'));
    writeFileSync(unit,worker());
    r = spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(r.status,0); assert.deepEqual(JSON.parse(r.stdout).checks.map(c=>c.result),['PASS','PASS']);
    writeFileSync(nginx,https('client_max_body_size 1m; # PRIVATE_SENTINEL\n'));
    r = spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(r.status,1); assert.doesNotMatch(r.stdout,/PRIVATE_SENTINEL/);
    chmodSync(root,0o755); chmodSync(nginx,0o000); chmodSync(unit,0o000);
    r = spawnSync(process.execPath,args,{encoding:'utf8',...(process.getuid()===0 ? {uid:65534,gid:65534} : {})});
    assert.equal(r.status,0,r.stderr); assert.deepEqual(JSON.parse(r.stdout).checks.map(c=>c.result),['NOT_RUN','NOT_RUN']);
    assert.doesNotMatch(r.stdout,/PRIVATE_SENTINEL/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('systemctl unavailability is NOT_RUN and its stderr is never published', () => {
  const result = runPreflight({nginxConfig:'/workspace/data/task132/nonexistent'}, { systemctl: () => ({status:1,stderr:'PRIVATE_SENTINEL'}) });
  assert.equal(result.checks[1].result,'NOT_RUN');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SENTINEL/);
});
