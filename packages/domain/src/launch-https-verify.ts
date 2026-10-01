/**
 * Step 30 Phase 3 — read-only public HTTPS / DNS / TLS verification helpers.
 */

import { createConnection } from 'node:net';
import tls from 'node:tls';
import { resolveHostnameIpv4 } from './dns-verify.js';
import {
  PHASE3_API,
  PHASE3_EXPECTED_PUBLIC_IP,
  PHASE3_WEB,
} from './launch-phase3-verify-only.js';

export type PublicHttpsVerifyResult = {
  ok: boolean;
  hostname: string;
  url: string;
  dnsCorrect: boolean;
  dnsAddresses: string[];
  tcp443: boolean;
  tlsOk: boolean;
  certificateValid: boolean;
  daysRemaining: number | null;
  httpStatus: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  bodySnippetSafe: string | null;
};

function tcpProbe(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

function tlsProbe(hostname: string, timeoutMs = 8000): Promise<{
  ok: boolean;
  daysRemaining: number | null;
  authorized: boolean;
}> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: hostname,
        servername: hostname,
        port: 443,
        rejectUnauthorized: true,
      },
      () => {
        const cert = socket.getPeerCertificate();
        let daysRemaining: number | null = null;
        if (cert?.valid_to) {
          const exp = new Date(cert.valid_to).getTime();
          daysRemaining = Math.floor((exp - Date.now()) / (24 * 3600 * 1000));
        }
        const authorized = socket.authorized;
        socket.end();
        resolve({
          ok: authorized && (daysRemaining == null || daysRemaining >= 0),
          daysRemaining,
          authorized,
        });
      },
    );
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, daysRemaining: null, authorized: false });
    });
    socket.on('error', () => resolve({ ok: false, daysRemaining: null, authorized: false }));
  });
}

async function httpGetStatus(url: string): Promise<{ status: number; bodySnippet: string }> {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => '');
  return {
    status: res.status,
    bodySnippet: text.slice(0, 200).replace(/[\u0000-\u001f]/g, ' '),
  };
}

export async function verifyPublicHttps(input: {
  hostname: string;
  url: string;
  expectedIp: string;
  acceptStatuses: number[];
}): Promise<PublicHttpsVerifyResult> {
  const dns = await resolveHostnameIpv4(input.hostname);
  const dnsCorrect = dns.addresses.includes(input.expectedIp);
  const tcp443 = await tcpProbe(input.hostname, 443);
  const tls = await tlsProbe(input.hostname);
  let httpStatus: number | null = null;
  let bodySnippetSafe: string | null = null;
  let httpOk = false;
  try {
    const http = await httpGetStatus(input.url);
    httpStatus = http.status;
    bodySnippetSafe = http.bodySnippet;
    httpOk = input.acceptStatuses.includes(http.status);
  } catch (err) {
    return {
      ok: false,
      hostname: input.hostname,
      url: input.url,
      dnsCorrect,
      dnsAddresses: dns.addresses,
      tcp443,
      tlsOk: tls.ok,
      certificateValid: tls.ok,
      daysRemaining: tls.daysRemaining,
      httpStatus: null,
      failureCode: 'HTTPS_REQUEST_FAILED',
      failureMessage: err instanceof Error ? err.message : 'https_request_failed',
      bodySnippetSafe: null,
    };
  }

  const ok = dnsCorrect && tcp443 && tls.ok && httpOk;
  let failureCode: string | null = null;
  if (!dnsCorrect) failureCode = 'DNS_DRIFT_WRONG_VALUE';
  else if (!tcp443) failureCode = 'TCP_443_UNREACHABLE';
  else if (!tls.ok) failureCode = 'CERTIFICATE_INVALID';
  else if (!httpOk) failureCode = 'HTTPS_STATUS_UNEXPECTED';

  return {
    ok,
    hostname: input.hostname,
    url: input.url,
    dnsCorrect,
    dnsAddresses: dns.addresses,
    tcp443,
    tlsOk: tls.ok,
    certificateValid: tls.ok,
    daysRemaining: tls.daysRemaining,
    httpStatus,
    failureCode,
    failureMessage: failureCode,
    bodySnippetSafe,
  };
}

export async function verifyApiPublicHttps(
  expectedIp = PHASE3_EXPECTED_PUBLIC_IP,
): Promise<PublicHttpsVerifyResult> {
  return verifyPublicHttps({
    hostname: PHASE3_API.hostname,
    url: PHASE3_API.healthUrl,
    expectedIp,
    acceptStatuses: [200, 201, 204],
  });
}

export async function verifyWebPublicHttps(
  expectedIp = PHASE3_EXPECTED_PUBLIC_IP,
): Promise<PublicHttpsVerifyResult & { publicApiUrlPresent: boolean | null }> {
  const base = await verifyPublicHttps({
    hostname: PHASE3_WEB.hostname,
    url: PHASE3_WEB.healthUrl,
    expectedIp,
    acceptStatuses: [200, 301, 302, 307, 308],
  });
  let publicApiUrlPresent: boolean | null = null;
  if (base.ok && base.bodySnippetSafe) {
    publicApiUrlPresent = base.bodySnippetSafe.includes('api-launchos')
      ? true
      : null; // HTML may not inline URL; treat null as unknown (not failure)
  }
  return { ...base, publicApiUrlPresent };
}
