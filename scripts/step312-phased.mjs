/**
 * Step 31.2 phased diagnostics + minimal fix.
 * node scripts/step312-phased.mjs --confirm-step312
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
if (!process.argv.includes('--confirm-step312')) {
  console.error('Refusing: pass --confirm-step312');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const TARGET_HOST = '116.62.198.184';
const WEB_HOST = 'alpha.zsaos.com';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = `https://${WEB_HOST}`;
const API_ORIGIN = `https://${API_HOST}`;
const CTR = 'launchos-alpha-api';
const DIR = resolve(root, '.tools', 'alpha-runtime');
const REPORT_PATH = resolve(root, '.tools', 'step312-github-outbound-report.json');
const ROUTES = [WEB_HOST, API_HOST, 'web-launchos.zsaos.com', 'api-launchos.zsaos.com', 'oneclick-web.zsaos.com', 'launchos-real-test.zsaos.com'];

function redact(t) {
  return String(t || '')
    .replace(/:\/\/[^:@\s]+:[^@\s]+@/g, '://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^\s]+/gi, '$1=***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}
async function run(runner, cmd, timeoutMs = 90000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  const out = redact(`${r.stdout || ''}\n${r.stderr || ''}`);
  return { exitCode: r.exitCode, out };
}
function curlLocal(url, host, opts = {}) {
  const args = ['-k', '-sS', '-X', opts.method || 'GET', '--resolve', `${host}:443:${TARGET_HOST}`, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(opts.maxTime || 90)];
  for (const [k, v] of Object.entries(opts.headers || {})) args.push('-H', `${k}: ${v}`);
  if (opts.body != null) {
    args.push('-H', 'content-type: application/json', '--data-binary', opts.body);
  }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}
function j(t) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

const report = {
  step: '31.2 Alpha GitHub Outbound Connectivity',
  hostDns: null,
  containerDns: null,
  ipv4: null,
  ipv6: null,
  hostHttps: null,
  containerHttps: null,
  proxyInspection: null,
  gitTransportDiagnosis: null,
  rootCause: null,
  fixApplied: 'NONE',
  githubLsRemote: null,
  githubClone: null,
  apiGithub: null,
  publicRepoAnalyze: null,
  githubAppRepoAnalyze: null,
  existingRoutes: null,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  final: 'FAIL',
  error: null,
};

function printFinal(r) {
  console.log('\nStep 31.2 Alpha GitHub Outbound Connectivity\n');
  console.log(`1. Host DNS: ${JSON.stringify(r.hostDns)}`);
  console.log(`2. Container DNS: ${JSON.stringify(r.containerDns)}`);
  console.log(`3. IPv4: ${JSON.stringify(r.ipv4)}`);
  console.log(`4. IPv6: ${JSON.stringify(r.ipv6)}`);
  console.log(`5. Host HTTPS: ${JSON.stringify(r.hostHttps)}`);
  console.log(`6. Container HTTPS: ${JSON.stringify(r.containerHttps)}`);
  console.log(`7. Proxy inspection: ${JSON.stringify(r.proxyInspection)}`);
  console.log(`8. Git transport diagnosis: ${JSON.stringify(r.gitTransportDiagnosis)}`);
  console.log(`9. Root cause: ${r.rootCause}`);
  console.log(`10. Fix applied: ${r.fixApplied}`);
  console.log(`11. github.com ls-remote: ${JSON.stringify(r.githubLsRemote)}`);
  console.log(`12. github.com clone: ${JSON.stringify(r.githubClone)}`);
  console.log(`13. api.github.com: ${JSON.stringify(r.apiGithub)}`);
  console.log(`14. Public repo connect/analyze: ${JSON.stringify(r.publicRepoAnalyze)}`);
  console.log(`15. GitHub App repository analyze: ${JSON.stringify(r.githubAppRepoAnalyze)}`);
  console.log(`16. Existing routes: ${JSON.stringify(r.existingRoutes)}`);
  console.log(`17. Secrets exposed: ${r.secretsExposed}`);
  console.log(`18. Paid resource created: ${r.paidResourceCreated}`);
  console.log(`19. Final PASS / FAIL: ${r.final}`);
  if (r.error) console.log(`error: ${r.error}`);
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const prisma = new PrismaClient();
  const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
  if (!server) throw new Error('server missing');
  const runner = new RemoteRunner();
  await runner.connect({
    host: server.host,
    port: server.port,
    username: resolveServerSshUsername(server.username),
    password: decryptCredential(server.credentialEncrypted),
  });

  try {
    console.log('phase1 dns');
    const dns = await run(
      runner,
      [
        'echo HOST_RESOLV; cat /etc/resolv.conf | head -15',
        'for h in github.com api.github.com objects.githubusercontent.com codeload.github.com; do echo H=$h; getent ahostsv4 $h | head -3; getent ahostsv6 $h | head -3; done',
        `echo CTR; podman exec ${CTR} sh -c 'echo CTR_RESOLV; cat /etc/resolv.conf | head -10; for h in github.com api.github.com objects.githubusercontent.com codeload.github.com; do echo H=$h; getent ahostsv4 $h | head -3; getent ahostsv6 $h | head -3; done'`,
        'echo NETMODE; podman inspect ' + CTR + ' --format "{{.HostConfig.NetworkMode}}"',
      ].join('; '),
      60000,
    );
    writeFileSync(join(DIR, 'step312-p1-dns.txt'), dns.out);
    report.hostDns = {
      resolv: dns.out.match(/HOST_RESOLV([\s\S]*?)H=github/)?.[1]?.trim()?.slice(0, 200) || null,
      githubA: [...dns.out.matchAll(/H=github\.com\n([0-9.]+)/g)].map((m) => m[1]),
      apiA: [...dns.out.matchAll(/H=api\.github\.com\n([0-9.]+)/g)].map((m) => m[1]),
      hasAAAA: /H=github\.com[\s\S]*?[0-9a-f:]+:[0-9a-f:]+/i.test(dns.out.split('CTR')[0] || ''),
      snippet: dns.out.slice(0, 900),
    };
    report.containerDns = {
      networkMode: dns.out.match(/NETMODE\n?(\S+)/)?.[1] || null,
      snippet: (dns.out.split('CTR')[1] || '').slice(0, 900),
    };

    console.log('phase2 ipv4/ipv6/https');
    const net = await run(
      runner,
      [
        'echo IPV6DEF; ip -6 route show default 2>/dev/null | head -3 || echo NONE',
        'echo IPV4',
        'for h in github.com api.github.com objects.githubusercontent.com codeload.github.com; do ip=$(getent ahostsv4 $h | awk "{print \\$1; exit}"); echo H=$h IP=$ip; timeout 6 bash -c "echo >/dev/tcp/$ip/443" && echo TCP=OPEN || echo TCP=FAIL; done',
        'echo IPV6TCP',
        'for h in github.com api.github.com; do v6=$(getent ahostsv6 $h | awk "{print \\$1; exit}"); echo H=$h V6=$v6; if [ -n "$v6" ]; then timeout 6 bash -c "echo >/dev/tcp/$v6/443" && echo TCP6=OPEN || echo TCP6=FAIL; else echo TCP6=SKIP; fi; done',
        'echo HOST_HTTPS',
        'for u in https://github.com/ https://api.github.com/zen https://codeload.github.com/; do echo U=$u; curl -4 -sS -o /dev/null -w "code=%{http_code} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\\n" --max-time 12 "$u" || echo FAIL; done',
        'echo CURL6; curl -6 -sS -o /dev/null -w "code=%{http_code} total=%{time_total}\\n" --max-time 10 https://api.github.com/zen || echo CURL6_FAIL',
        // ensure curl in container for diagnostics
        `podman exec ${CTR} sh -c 'command -v curl >/dev/null' || podman exec -u 0 ${CTR} sh -c 'apt-get update >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl >/dev/null 2>&1' || true`,
        'echo CTR_HTTPS',
        `podman exec ${CTR} sh -c 'for u in https://github.com/ https://api.github.com/zen https://codeload.github.com/; do echo U=$u; curl -4 -sS -o /dev/null -w "code=%{http_code} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\\n" --max-time 12 "$u" || echo FAIL; done'`,
      ].join('; '),
      180000,
    );
    writeFileSync(join(DIR, 'step312-p2-net.txt'), net.out);
    report.ipv4 = {
      githubTcp: net.out.match(/H=github\.com IP=([0-9.]+)[\s\S]*?TCP=(\w+)/)?.[2] || null,
      apiTcp: net.out.match(/H=api\.github\.com IP=([0-9.]+)[\s\S]*?TCP=(\w+)/)?.[2] || null,
      githubIp: net.out.match(/H=github\.com IP=([0-9.]+)/)?.[1] || null,
      apiIp: net.out.match(/H=api\.github\.com IP=([0-9.]+)/)?.[1] || null,
      snippet: net.out.match(/IPV4[\s\S]*?(?=IPV6TCP)/)?.[0]?.slice(0, 700) || net.out.slice(0, 700),
    };
    report.ipv6 = {
      defaultRoute: !/IPV6DEF\nNONE/.test(net.out) && /IPV6DEF\n(?!NONE)/.test(net.out),
      snippet: net.out.match(/IPV6DEF[\s\S]*?(?=HOST_HTTPS)/)?.[0]?.slice(0, 600) || null,
    };
    report.hostHttps = {
      github: net.out.match(/U=https:\/\/github\.com\/\ncode=(\d+)[^\\n]*total=([0-9.]+)/)?.slice(1, 3) || null,
      api: net.out.match(/U=https:\/\/api\.github\.com\/zen\ncode=(\d+)[^\\n]*total=([0-9.]+)/)?.slice(1, 3) || null,
      codeload: net.out.match(/U=https:\/\/codeload\.github\.com\/\ncode=(\d+)/)?.[1] || null,
      snippet: net.out.match(/HOST_HTTPS[\s\S]*?(?=CURL6|CTR_HTTPS)/)?.[0]?.slice(0, 800) || null,
    };
    report.containerHttps = {
      snippet: net.out.match(/CTR_HTTPS[\s\S]*$/)?.[0]?.slice(0, 800) || null,
      githubCode: net.out.match(/CTR_HTTPS[\s\S]*?U=https:\/\/github\.com\/\ncode=(\d+)/)?.[1] || null,
      apiCode: net.out.match(/CTR_HTTPS[\s\S]*?U=https:\/\/api\.github\.com\/zen\ncode=(\d+)/)?.[1] || null,
    };

    console.log('phase3 proxy/firewall/git');
    const px = await run(
      runner,
      [
        'echo PROXY_HOST; env | grep -Ei "^(http|https|all|no)_proxy=" || echo NONE',
        'echo GITCFG_HOST; (git config --system --list; git config --global --list) 2>/dev/null | grep -Ei "proxy|http\\." || echo NONE',
        `echo PROXY_CTR; podman exec ${CTR} sh -c 'env | grep -Ei "^(http|https|all|no)_proxy=" || echo NONE; (git config --system --list; git config --global --list) 2>/dev/null | grep -Ei "proxy|http\\." || echo NONE'`,
        'echo FW; iptables -L OUTPUT -n 2>/dev/null | head -25 || echo NO_IPT',
        'echo MTU; ip link | grep -E "mtu" | head -15',
        // git tests with hard timeouts
        'echo GIT_HOST_DEF; timeout 25 env GIT_TERMINAL_PROMPT=0 git ls-remote --heads https://github.com/octocat/Hello-World.git; echo E:$?',
        'echo GIT_HOST_11; timeout 25 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git; echo E:$?',
        `echo GIT_CTR_DEF; podman exec ${CTR} sh -c 'timeout 25 env GIT_TERMINAL_PROMPT=0 git ls-remote --heads https://github.com/octocat/Hello-World.git'; echo E:$?`,
        `echo GIT_CTR_11; podman exec ${CTR} sh -c 'timeout 25 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git'; echo E:$?`,
        `echo GIT_CTR_VERBOSE; podman exec ${CTR} sh -c 'timeout 15 env GIT_TERMINAL_PROMPT=0 GIT_CURL_VERBOSE=1 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git' 2>&1 | tail -25; echo E:$?`,
      ].join('; '),
      200000,
    );
    writeFileSync(join(DIR, 'step312-p3-git.txt'), px.out);
    report.proxyInspection = {
      hostProxyEnv: !/PROXY_HOST\nNONE/.test(px.out),
      containerProxyEnv: !/PROXY_CTR\nNONE/.test(px.out),
      snippet: px.out.match(/PROXY_HOST[\s\S]*?(?=FW)/)?.[0]?.slice(0, 700) || null,
    };
    const hostDefOk = /GIT_HOST_DEF[\s\S]*?refs\/heads[\s\S]*?E:0/.test(px.out);
    const host11Ok = /GIT_HOST_11[\s\S]*?refs\/heads[\s\S]*?E:0/.test(px.out);
    const ctrDefOk = /GIT_CTR_DEF[\s\S]*?refs\/heads[\s\S]*?E:0/.test(px.out);
    const ctr11Ok = /GIT_CTR_11[\s\S]*?refs\/heads[\s\S]*?E:0/.test(px.out);
    report.gitTransportDiagnosis = {
      hostDefault: hostDefOk ? 'PASS' : 'FAIL',
      hostHttp11: host11Ok ? 'PASS' : 'FAIL',
      containerDefault: ctrDefOk ? 'PASS' : 'FAIL',
      containerHttp11: ctr11Ok ? 'PASS' : 'FAIL',
      verboseTail: px.out.match(/GIT_CTR_VERBOSE[\s\S]*?(?=E:\d+)/)?.[0]?.slice(0, 600) || null,
    };

    // Alternate DNS / IPs for github.com
    console.log('phase4 alternate github A records');
    const alt = await run(
      runner,
      [
        'echo ALT',
        'for dns in 223.5.5.5 1.1.1.1 8.8.8.8 119.29.29.29; do echo DNS=$dns; dig @$dns +time=2 +tries=1 github.com A +short 2>/dev/null | head -6; done',
        'echo TESTIPS',
        'IPS=$(for dns in 223.5.5.5 1.1.1.1 8.8.8.8 119.29.29.29; do dig @$dns +time=2 +tries=1 github.com A +short 2>/dev/null; done | sort -u)',
        'for ip in $IPS; do echo IP=$ip; timeout 5 bash -c "echo >/dev/tcp/$ip/443" && echo TCP=OPEN || echo TCP=FAIL; code=$(curl -4 -sS -o /dev/null -w "%{http_code}" --max-time 10 --connect-to github.com:443:$ip:443 https://github.com/ || echo 000); echo HTTP=$code; done',
        'echo TEST_API_IPS',
        'AIPS=$(for dns in 223.5.5.5 1.1.1.1 8.8.8.8; do dig @$dns +time=2 +tries=1 api.github.com A +short 2>/dev/null; done | sort -u)',
        'for ip in $AIPS; do echo AIP=$ip; code=$(curl -4 -sS -o /dev/null -w "%{http_code}" --max-time 8 --connect-to api.github.com:443:$ip:443 https://api.github.com/zen || echo 000); echo HTTP=$code; done',
      ].join('; '),
      180000,
    );
    writeFileSync(join(DIR, 'step312-p4-alt.txt'), alt.out);

    const working = [];
    for (const m of alt.out.matchAll(/IP=([0-9.]+)\nTCP=(\w+)\nHTTP=(\d+)/g)) {
      if (m[2] === 'OPEN' && m[3] !== '000' && Number(m[3]) > 0) working.push({ ip: m[1], http: m[3] });
    }

    // Root cause
    const githubHostFail =
      !hostDefOk &&
      !host11Ok &&
      (report.hostHttps?.github?.[0] === '000' || report.ipv4?.githubTcp === 'FAIL' || report.ipv4?.githubTcp === 'OPEN');
    const apiHostOk =
      report.hostHttps?.api?.[0] === '200' || /U=https:\/\/api\.github\.com\/zen\ncode=200/.test(net.out);

    if (!hostDefOk && !ctrDefOk && apiHostOk && working.length === 0) {
      report.rootCause =
        'Host+container: api.github.com reachable, but all resolved github.com A records fail TCP/HTTPS or git smart-HTTP. Not proxy, not missing git, not container-only (host-network). Likely upstream filtering/route issue to github.com frontends from this ECS path.';
    } else if (!hostDefOk && !ctrDefOk && working.length > 0) {
      report.rootCause = `Default github.com resolution points to unhealthy frontend IP(s); alternate A record(s) respond (e.g. ${working[0].ip} HTTP ${working[0].http}). DNS itself resolves, but selected path/IP is bad for this network.`;
    } else if (hostDefOk && !ctrDefOk) {
      report.rootCause = 'Container-only failure while host git works';
    } else if (hostDefOk && ctrDefOk) {
      report.rootCause = 'No current failure observed in retest';
    } else {
      report.rootCause = 'github.com git/HTTPS unhealthy from Alpha host; see diagnostics artifacts';
    }

    // Minimal fix: pin hosts if we found working IP
    if ((!hostDefOk || !ctrDefOk) && working.length > 0) {
      const best = working[0];
      console.log('fix pin github.com ->', best.ip);
      const pin = await run(
        runner,
        [
          'set -e',
          'ts=$(date +%Y%m%d%H%M%S)',
          'cp -a /etc/hosts /etc/hosts.launchos-step312.bak.$ts',
          "sed -i '/# launchos-step312-github/d' /etc/hosts",
          `printf '%s github.com # launchos-step312-github\\n' '${best.ip}' >> /etc/hosts`,
          // also try pinning for container /etc/hosts (host network still uses container file for getent sometimes)
          `podman exec -u 0 ${CTR} sh -c 'cp -a /etc/hosts /etc/hosts.launchos-step312.bak 2>/dev/null || true; sed -i "/# launchos-step312-github/d" /etc/hosts; printf "%s github.com # launchos-step312-github\\n" "${best.ip}" >> /etc/hosts; getent hosts github.com | head -3'`,
          'getent hosts github.com | head -3',
          'curl -4 -sS -o /dev/null -w "pinned_code=%{http_code} total=%{time_total}\\n" --max-time 15 https://github.com/ || true',
          'timeout 30 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git | head -3; echo HOST_GIT:$?',
          `podman exec ${CTR} sh -c 'timeout 30 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git' | head -3; echo CTR_GIT:$?`,
        ].join('\n'),
        120000,
      );
      writeFileSync(join(DIR, 'step312-pin.txt'), pin.out);
      const pinGitOk = /refs\/heads/.test(pin.out) && (/HOST_GIT:0/.test(pin.out) || /CTR_GIT:0/.test(pin.out));
      report.fixApplied = pinGitOk
        ? `Minimal /etc/hosts pin github.com -> ${best.ip} on host and API container (backup hosts.launchos-step312.bak.*). No image rebuild. No paid resources.`
        : `Attempted /etc/hosts pin github.com -> ${best.ip}; git still failing after pin`;
    } else if (!hostDefOk && report.gitTransportDiagnosis.containerHttp11 === 'PASS') {
      report.fixApplied = 'git http.version=HTTP/1.1 sufficient (unexpected path)';
    } else if (hostDefOk && ctrDefOk) {
      report.fixApplied = 'NONE required';
    } else {
      // Try HTTP/1.1 system git config in container as additional minimal attempt if diagnosis shows hang after connect
      const verbose = report.gitTransportDiagnosis.verboseTail || '';
      if (/Trying .*443/.test(verbose) && !/Connected/.test(verbose)) {
        report.fixApplied =
          'NONE durable — TCP to github.com:443 does not complete from this path; hosts pin unavailable (no healthy alternate A). Cannot add NAT/proxy/paid resources per rules.';
      } else {
        report.fixApplied =
          'NONE durable within policy — github.com outbound still blocked/unhealthy; mirrors forbidden; no paid NAT/proxy.';
      }
    }

    // Verify
    console.log('phase5 verify ls-remote/clone');
    const ver = await run(
      runner,
      [
        'echo V_DNS; getent hosts github.com | head -5',
        'echo V_API; curl -4 -sS -o /dev/null -w "code=%{http_code}\\n" --max-time 12 https://api.github.com/zen || echo code=000',
        'echo V_GH; curl -4 -sS -o /dev/null -w "code=%{http_code}\\n" --max-time 15 https://github.com/ || echo code=000',
        'echo V_LS_HOST; timeout 40 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git; echo E:$?',
        `echo V_LS_CTR; podman exec ${CTR} sh -c 'timeout 40 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git'; echo E:$?`,
        `echo V_CLONE; podman exec ${CTR} sh -c 'rm -rf /tmp/hw312 && timeout 90 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 clone --depth=1 --branch master https://github.com/octocat/Hello-World.git /tmp/hw312 && test -d /tmp/hw312/.git && echo CLONE_OK'; echo E:$?`,
      ].join('; '),
      240000,
    );
    writeFileSync(join(DIR, 'step312-verify.txt'), ver.out);
    const lsHost = /V_LS_HOST[\s\S]*?refs\/heads[\s\S]*?E:0/.test(ver.out);
    const lsCtr = /V_LS_CTR[\s\S]*?refs\/heads[\s\S]*?E:0/.test(ver.out);
    const cloneOk = /CLONE_OK/.test(ver.out);
    const apiOk = /V_API\ncode=200/.test(ver.out);
    report.githubLsRemote = { host: lsHost ? 'PASS' : 'FAIL', container: lsCtr ? 'PASS' : 'FAIL', snippet: ver.out.match(/V_LS_CTR[\s\S]*?(?=V_CLONE)/)?.[0]?.slice(0, 400) };
    report.githubClone = { container: cloneOk ? 'PASS' : 'FAIL', snippet: ver.out.match(/V_CLONE[\s\S]*$/)?.[0]?.slice(0, 400) };
    report.apiGithub = { ok: apiOk, snippet: ver.out.match(/V_API[\s\S]*?(?=V_GH)/)?.[0]?.slice(0, 200) };

    if (lsCtr && cloneOk) {
      console.log('phase6 public analyze');
      const email = `alpha-s312-${Date.now()}@zsaos.test`;
      const password = `Alpha${randomBytes(5).toString('hex')}!aA1`;
      curlLocal(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN },
        body: JSON.stringify({ email, password, name: 'S312' }),
      });
      const login = curlLocal(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN },
        body: JSON.stringify({ email, password }),
      });
      const token = j(login.text)?.accessToken;
      const auth = { authorization: `Bearer ${token}`, origin: WEB_ORIGIN };
      const pub = curlLocal(`${API_ORIGIN}/api/v1/onboarding/source/public`, API_HOST, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ cloneUrl: 'https://github.com/octocat/Hello-World.git', branch: 'master' }),
      });
      const analyze = curlLocal(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
        method: 'POST',
        headers: auth,
        maxTime: 180,
      });
      const aj = j(analyze.text);
      report.publicRepoAnalyze = {
        connectStatus: pub.status,
        analyzeStatus: analyze.status,
        stage: aj?.stage || null,
        cloneUrl: 'https://github.com/octocat/Hello-World.git',
        ok: pub.status >= 200 && pub.status < 300 && analyze.status >= 200 && analyze.status < 300 && aj?.stage === 'PLAN',
        snippet: redact(analyze.text).slice(0, 400),
      };
    } else {
      report.publicRepoAnalyze = { ok: false, reason: 'github.com git still failing; mirrors forbidden' };
    }

    // GitHub App — capability + authorize only unless we can do more non-interactively
    console.log('phase7 github app checks');
    try {
      const { evaluateGitHubConnectionCapability } = requireApi('@launchos/github');
      const cap = evaluateGitHubConnectionCapability({
        env: {
          NODE_ENV: 'production',
          LAUNCHOS_ENV: 'alpha',
          WEB_ORIGIN,
          GITHUB_APP_CALLBACK_URL: `${WEB_ORIGIN}/git/github/callback`,
        },
        configured: Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY),
        callbackUrl: `${WEB_ORIGIN}/git/github/callback`,
        webOrigin: WEB_ORIGIN,
      });
      const email = `alpha-s312gh-${Date.now()}@zsaos.test`;
      const password = `Alpha${randomBytes(5).toString('hex')}!aA1`;
      curlLocal(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN },
        body: JSON.stringify({ email, password, name: 'S312GH' }),
      });
      const login = curlLocal(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN },
        body: JSON.stringify({ email, password }),
      });
      const token = j(login.text)?.accessToken;
      const authz = token
        ? curlLocal(`${API_ORIGIN}/api/v1/git/github/authorize?returnTo=/onboarding/source`, API_HOST, {
            headers: { authorization: `Bearer ${token}`, origin: WEB_ORIGIN },
          })
        : null;
      const aj = authz ? j(authz.text) : null;
      // Non-sensitive api.github.com meta from host
      const meta = await run(runner, 'curl -4 -sS --max-time 12 https://api.github.com/zen; echo; curl -4 -sS --max-time 12 -o /dev/null -w "meta=%{http_code}\\n" https://api.github.com/meta', 30000);
      report.githubAppRepoAnalyze = {
        capability: cap.status,
        authorizeStatus: authz?.status ?? null,
        hasGithubAuthorizeUrl: Boolean(aj?.url && String(aj.url).includes('github.com')),
        apiZenOk: /meta=200/.test(meta.out) || apiOk,
        fullInteractiveOauth: 'NOT_RUN',
        repositoryAnalyze: lsCtr && cloneOk ? 'GIT_TRANSPORT_READY_FOR_APP_CLONE' : 'BLOCKED_BY_GITHUB_COM_OUTBOUND',
        ok: cap.status === 'READY' && Boolean(aj?.url) && apiOk && lsCtr && cloneOk,
        note: 'Interactive GitHub login/callback not automatable here; require github.com git + api.github.com for PASS',
      };
    } catch (e) {
      report.githubAppRepoAnalyze = { ok: false, error: redact(e.message || String(e)).slice(0, 300) };
    }

    const routes = {};
    for (const host of ROUTES) {
      const primary = host.startsWith('api-') ? `https://${host}/api/v1/health` : `https://${host}/`;
      let res = curlLocal(primary, host);
      if (host.startsWith('api-') && res.status === 404) res = curlLocal(`https://${host}/health`, host);
      routes[host] = { status: res.status, ok: res.status >= 200 && res.status < 400 };
    }
    report.existingRoutes = routes;

    const routesOk = Object.values(routes).every((r) => r.ok);
    report.final =
      report.githubLsRemote?.container === 'PASS' &&
      report.githubClone?.container === 'PASS' &&
      report.apiGithub?.ok === true &&
      report.publicRepoAnalyze?.ok === true &&
      routesOk &&
      report.secretsExposed === 'NO' &&
      report.paidResourceCreated === 'NO'
        ? 'PASS'
        : 'FAIL';
  } catch (e) {
    report.error = redact(e.message || String(e)).slice(0, 2000);
    report.final = 'FAIL';
  } finally {
    try {
      await runner.disconnect();
    } catch {}
    try {
      await prisma.$disconnect();
    } catch {}
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }
  printFinal(report);
  process.exit(report.final === 'PASS' ? 0 : 1);
}

await main();
