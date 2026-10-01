import { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function curlProbe(url, resolveHost, ip) {
  const args = ['-sS', '-k', '-L', '--max-time', '20', '-A', 'LaunchOS-Step35/1.0',
    '-w', '\n__CODE__:%{http_code}\n__IP__:%{remote_ip}\n'];
  if (ip) args.push('--resolve', `${resolveHost}:443:${ip}`);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 2_000_000 });
  const out = String(r.stdout || '');
  return {
    code: Number((out.match(/__CODE__:(\d+)/) || [])[1] || 0),
    remoteIp: (out.match(/__IP__:([^\n]+)/) || [])[1] || null,
    body: out.replace(/\n__CODE__:[\s\S]*$/, '').replace(/\s+/g, ' ').trim().slice(0, 180),
    stderr: String(r.stderr || '').slice(0, 200),
  };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const script = `#!/bin/bash
set +e
echo '===HOST_IPS==='
hostname -I 2>/dev/null || true
ip -4 addr show | sed -n 's/.*inet \\([0-9.]*\\).*/\\1/p' | head -20
echo '===CURL_LOCAL_ZSAOS==='
curl -sS -k -o /tmp/z1.txt -w 'real-test=%{http_code} ip=%{remote_ip}\\n' --max-time 15 https://launchos-real-test.zsaos.com/ || true
head -c 120 /tmp/z1.txt; echo
curl -sS -k -o /tmp/z2.txt -w 'multi=%{http_code} ip=%{remote_ip}\\n' --max-time 15 https://launchos-multi-demo-5.zsaos.com/ || true
head -c 120 /tmp/z2.txt; echo
curl -sS -k -o /tmp/z3.txt -w 'ceshi-zsaos=%{http_code} ip=%{remote_ip}\\n' --max-time 15 https://web-ceshi.zsaos.com/ || true
head -c 120 /tmp/z3.txt; echo
curl -sS -k -o /tmp/z4.txt -w 'ceshi-launchos-resolve-alpha=%{http_code}\\n' --resolve web-ceshi.launchos.app:443:127.0.0.1 --max-time 15 https://web-ceshi.launchos.app/ || true
head -c 120 /tmp/z4.txt; echo
echo '===NGINX_LISTEN==='
ss -lntp | grep -E ':443|:80' | head -20 || true
echo '===PUBLIC_IP_PROBE==='
curl -sS --max-time 5 ifconfig.me || true; echo
curl -sS --max-time 5 https://api.ipify.org || true; echo
`;

await runner.writeTextFile('/opt/launchos/tmp/step35-ip-dns.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step35-ip-dns.sh && /opt/launchos/tmp/step35-ip-dns.sh'),
  { timeoutMs: 90000 },
);
const remoteOut = String(r.stdout || '') + String(r.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step35-ip-dns.txt'), remoteOut);
console.log(remoteOut);

const external = {
  realTest: curlProbe('https://launchos-real-test.zsaos.com/', 'launchos-real-test.zsaos.com', null),
  multi: curlProbe('https://launchos-multi-demo-5.zsaos.com/', 'launchos-multi-demo-5.zsaos.com', null),
  ceshiZsaos: curlProbe('https://web-ceshi.zsaos.com/', 'web-ceshi.zsaos.com', null),
  ceshiLaunchos: curlProbe('https://web-ceshi.launchos.app/', 'web-ceshi.launchos.app', null),
  ceshiViaAlpha: curlProbe('https://web-ceshi.launchos.app/', 'web-ceshi.launchos.app', '116.62.198.184'),
  ceshiViaGwIp: curlProbe('https://web-ceshi.launchos.app/', 'web-ceshi.launchos.app', '8.138.113.134'),
};
writeFileSync(join(ARTIFACT_DIR, 'step35-external-probes.json'), JSON.stringify(external, null, 2));
console.log(JSON.stringify(external, null, 2));

await runner.disconnect();
await prisma.$disconnect();
