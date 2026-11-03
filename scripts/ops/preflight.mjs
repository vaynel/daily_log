// Read-only checks. Never print configuration contents or systemctl stderr.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const check = (id, result, detail) => ({ id, result, detail });

// Read the source policy without executing TypeScript or maintaining a second limit.
// Unsupported future policy expressions must be investigated, never guessed.
function uploadThreshold() {
  const source = readFileSync(new URL('../../apps/server/src/attachments/policy.ts', import.meta.url), 'utf8');
  const expression = source.match(/\bphotoBytes:\s*([\d\s*]+),/)?.[1]?.trim();
  if (!expression || !/^\d+(?:\s*\*\s*\d+)*$/.test(expression)) throw new Error('POLICY_UNREADABLE');
  const bytes = expression.split('*').reduce((n, value) => n * Number(value.trim()), 1);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('POLICY_UNREADABLE');
  return bytes + 1024;
}

// Small structural parser: comments/quoted strings cannot introduce directives or braces.
// Includes are intentionally not expanded: a single supplied file cannot prove their values.
function parseConfig(source) {
  const tokens = [];
  let word = '', quote = null, comment = false, escaped = false, started = false;
  const flush = () => { if (started) tokens.push({word}); word = ''; started = false; };
  for (const char of source) {
    if (comment) { if (char === '\n') comment = false; else continue; }
    if (escaped) { word += char; started = true; escaped = false; continue; }
    if (char === '\\') { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = null; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === '#') { flush(); comment = true; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    if ('{};'.includes(char)) { flush(); tokens.push({punct:char}); continue; }
    word += char; started = true;
  }
  if (quote || escaped) throw new Error('CONFIG_UNPARSEABLE');
  flush();
  const root = {args:[], children:[]};
  const stack = [root];
  let args = [];
  for (const token of tokens) {
    if (token.word !== undefined) { args.push(token.word); continue; }
    if (token.punct === '}') {
      if (args.length || stack.length === 1) throw new Error('CONFIG_UNPARSEABLE');
      stack.pop(); continue;
    }
    if (!args.length) throw new Error('CONFIG_UNPARSEABLE');
    const node = {args, children: token.punct === '{' ? [] : null};
    stack.at(-1).children.push(node); args = [];
    if (node.children) stack.push(node);
  }
  if (args.length || stack.length !== 1) throw new Error('CONFIG_UNPARSEABLE');
  return root;
}

export function checkNginx(source) {
  const id = 'nginx-upload-limit';
  let tree, threshold;
  try { tree = parseConfig(source); threshold = uploadThreshold(); }
  catch { return check(id, 'NOT_RUN', 'Configuration or app photo policy could not be parsed'); }
  let servers = 0, failures = 0, unresolved = false;
  function visit(node, inherited, inHttps = false) {
    if (!node.children) return;
    const limits = node.children.filter(c => c.args[0] === 'client_max_body_size');
    let limit = inherited;
    if (limits.length) {
      const match = limits.length === 1 && limits[0].args.length === 2 && /^(\d+)([kKmMgG]?)$/.exec(limits[0].args[1]);
      limit = match ? Number(match[1]) * ({k:1024,m:1024*1024,g:1024*1024*1024}[match[2].toLowerCase()] ?? 1) : NaN;
    }
    if (node.args[0] === 'server') {
      inHttps = node.children.some(c => c.args[0] === 'listen' && (c.args.includes('ssl') || /(?:^|:)443$/.test(c.args[1] ?? '')));
      if (inHttps) servers++;
    }
    if (inHttps && (!Number.isSafeInteger(limit) || limit <= threshold)) failures++;
    for (const child of node.children) {
      if (child.args[0] === 'include') unresolved = true;
      visit(child, limit, inHttps);
    }
  }
  visit(tree, undefined);
  if (failures) return check(id, 'FAIL', `HTTPS scope has missing, unlimited, invalid or insufficient upload limit; required > ${threshold} bytes`);
  if (!servers || unresolved) return check(id, 'NOT_RUN', 'HTTPS server not found or unresolved include; inspect effective configuration');
  return check(id, 'PASS', `All ${servers} HTTPS servers and nested scopes have finite upload limits > ${threshold} bytes`);
}

function duration(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  if (/^\d+$/.test(value)) return Number(value); // bare *USec property: microseconds
  const units = {us:1, 'µs':1, ms:1000, s:1e6, min:60e6, h:3600e6, d:86400e6};
  let total = 0, rest = value.trim();
  while (rest) {
    const part = /^(\d+(?:\.\d+)?)\s*(us|µs|ms|min|s|h|d)(?:\s*|$)/.exec(rest);
    if (!part) return NaN;
    total += Number(part[1]) * units[part[2]];
    rest = rest.slice(part[0].length);
  }
  return total;
}

export function checkWorker(source) {
  const id = 'worker-restart-policy';
  const properties = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (!match || properties.has(match[1])) return check(id, 'FAIL', 'Malformed or duplicate worker properties');
    properties.set(match[1], match[2].trim());
  }
  const delay = duration(properties.get('RestartUSec'));
  if ((properties.has('LoadState') && properties.get('LoadState') !== 'loaded') ||
      !['on-failure','always'].includes(properties.get('Restart')) ||
      !Number.isFinite(delay) || delay <= 0 || duration(properties.get('StartLimitIntervalUSec')) !== 0) {
    return check(id, 'FAIL', 'Require installed worker, Restart=on-failure|always, finite RestartUSec>0 and StartLimitIntervalUSec=0');
  }
  return check(id, 'PASS', 'Restart policy enabled, positive delay, start rate limiting disabled');
}

export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = {'--nginx-config':'nginxConfig','--worker-properties':'workerProperties'}[args[i]];
    if (!key || !args[i+1] || args[i+1].startsWith('--') || options[key]) throw new Error('INVALID_ARGUMENTS');
    options[key] = args[i+1];
  }
  return options;
}

export function runPreflight(options = {}, dependencies = {}) {
  const readCheck = (id, path, inspect) => {
    try { return inspect(readFileSync(path, 'utf8')); }
    catch { return check(id, 'NOT_RUN', 'Configuration file unavailable or unreadable'); }
  };
  const nginx = readCheck('nginx-upload-limit', options.nginxConfig ?? '/etc/nginx/conf.d/daily-log.conf', checkNginx);
  let worker;
  if (options.workerProperties) worker = readCheck('worker-restart-policy', options.workerProperties, checkWorker);
  else {
    try {
      const systemctl = dependencies.systemctl ?? (() => spawnSync('systemctl', ['--user','show','daily-log-worker','-p','Restart','-p','RestartUSec','-p','StartLimitIntervalUSec','-p','LoadState'], {encoding:'utf8', timeout:5000, maxBuffer:65536}));
      const output = systemctl();
      worker = output.status === 0 && !output.error ? checkWorker(output.stdout) : check('worker-restart-policy','NOT_RUN','Worker properties unavailable from systemctl --user show');
    } catch { worker = check('worker-restart-policy','NOT_RUN','Worker properties unavailable from systemctl --user show'); }
  }
  return {checks:[nginx,worker]};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runPreflight(parseOptions(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    process.exitCode = result.checks.some(c => c.result === 'FAIL') ? 1 : 0;
  } catch {
    console.log(JSON.stringify({checks:[check('arguments','FAIL','Invalid preflight arguments')]}));
    process.exitCode = 1;
  }
}
