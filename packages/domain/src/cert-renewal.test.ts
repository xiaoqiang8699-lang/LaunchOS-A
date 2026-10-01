import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldRenewCertificate, daysUntil } from './cert-renewal-logic';
import { MemoryDnsTxtProvider } from './alibaba-dns-provider';
import { waitForTxtPropagation } from './dns-txt-verify';
import {
  buildAtomicInstallScript,
  buildRollbackCertScript,
  certLayout,
} from './cert-install';
import { systemTlsRenewJobId } from '@launchos/shared';

describe('shouldRenewCertificate', () => {
  it('does not renew when more than 30 days remain', () => {
    const now = new Date('2026-09-15T00:00:00Z');
    const expiresAt = new Date('2026-12-14T23:59:59Z');
    const result = shouldRenewCertificate({ expiresAt, now, renewBeforeDays: 30 });
    assert.equal(result.shouldRenew, false);
    assert.equal(result.reason, 'NOT_YET');
    assert.ok((result.daysRemaining ?? 0) > 30);
  });

  it('renews when within 30 days', () => {
    const now = new Date('2026-11-20T00:00:00Z');
    const expiresAt = new Date('2026-12-14T23:59:59Z');
    const result = shouldRenewCertificate({ expiresAt, now, renewBeforeDays: 30 });
    assert.equal(result.shouldRenew, true);
    assert.equal(result.reason, 'WITHIN_WINDOW');
  });

  it('renews when already expired', () => {
    const now = new Date('2026-12-20T00:00:00Z');
    const expiresAt = new Date('2026-12-14T23:59:59Z');
    const result = shouldRenewCertificate({ expiresAt, now, renewBeforeDays: 30 });
    assert.equal(result.shouldRenew, true);
    assert.equal(result.reason, 'EXPIRED');
  });
});

describe('BullMQ job id dedupe key', () => {
  it('is stable per root domain', () => {
    assert.equal(systemTlsRenewJobId('zsaos.com'), 'system-tls-renew-zsaos.com');
    assert.equal(systemTlsRenewJobId(' Zsaos.COM '), 'system-tls-renew-zsaos.com');
  });
});

describe('MemoryDnsTxtProvider precise delete', () => {
  it('creates and deletes only the matching record id', async () => {
    const dns = new MemoryDnsTxtProvider();
    const a = await dns.createTxtRecord('_acme-challenge', 'value-a');
    const b = await dns.createTxtRecord('_acme-challenge', 'value-b');
    assert.equal(dns.listAll().length, 2);
    await dns.deleteTxtRecord(a.recordId);
    const left = dns.listAll();
    assert.equal(left.length, 1);
    assert.equal(left[0]?.recordId, b.recordId);
    assert.equal(left[0]?.value, 'value-b');
  });

  it('refuses apex/www hosts', async () => {
    const dns = new MemoryDnsTxtProvider();
    await assert.rejects(() => dns.createTxtRecord('@', 'x'));
    await assert.rejects(() => dns.createTxtRecord('www', 'x'));
    await assert.rejects(() => dns.createTxtRecord('*', 'x'));
  });

  it('allows _launchos-verify test hosts', async () => {
    const dns = new MemoryDnsTxtProvider();
    const ref = await dns.createTxtRecord('_launchos-verify-abcd', 'test-value');
    assert.match(ref.rr, /^_launchos-verify-/);
    await dns.deleteTxtRecord(ref.recordId);
  });
});

describe('assertSystemDnsRootDomain', () => {
  it('rejects mismatched root domain', async () => {
    const { assertSystemDnsRootDomain } = await import('./alibaba-dns-provider');
    assert.throws(() => assertSystemDnsRootDomain('evil.com', 'zsaos.com'));
  });
});

describe('normalizeAliyunDnsTtl', () => {
  it('raises TTL below 600 to 600', async () => {
    const { normalizeAliyunDnsTtl } = await import('./alibaba-dns-provider');
    assert.equal(normalizeAliyunDnsTtl(60), 600);
    assert.equal(normalizeAliyunDnsTtl(300), 600);
  });

  it('keeps TTL at or above 600 within range', async () => {
    const { normalizeAliyunDnsTtl } = await import('./alibaba-dns-provider');
    assert.equal(normalizeAliyunDnsTtl(600), 600);
    assert.equal(normalizeAliyunDnsTtl(3600), 3600);
  });

  it('caps TTL above 86400', async () => {
    const { normalizeAliyunDnsTtl } = await import('./alibaba-dns-provider');
    assert.equal(normalizeAliyunDnsTtl(100_000), 86400);
  });

  it('defaults missing TTL to 600', async () => {
    const { normalizeAliyunDnsTtl } = await import('./alibaba-dns-provider');
    assert.equal(normalizeAliyunDnsTtl(undefined), 600);
  });
});

describe('AlibabaCloudDnsProvider createTxtRecord TTL', () => {
  it('passes normalized TTL to AddDomainRecord', async () => {
    const { AlibabaCloudDnsProvider } = await import('./alibaba-dns-provider');
    let capturedTtl: number | undefined;
    const provider = new AlibabaCloudDnsProvider(
      { accessKey: 'test-key', secretKey: 'test-secret' },
      'zsaos.com',
    );
    (provider as unknown as { client: { addDomainRecord: (req: { TTL?: number }) => Promise<{ body: { recordId: string } }> } }).client = {
      addDomainRecord: async (req) => {
        capturedTtl = req.TTL;
        return { body: { recordId: 'rec-test-1' } };
      },
    };
    await provider.createTxtRecord('_launchos-verify-test', 'value', 60);
    assert.equal(capturedTtl, 600);
  });
});

describe('DNS propagation timeout', () => {
  it('times out quickly when TXT never appears', async () => {
    const result = await waitForTxtPropagation({
      hostname: `missing-challenge-${Date.now()}.invalid`,
      expectedValue: 'never-match',
      timeoutMs: 50,
      intervalMs: 20,
    });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
  });
});

describe('atomic cert install script', () => {
  it('validates key match and preserves previous before switch', () => {
    const script = buildAtomicInstallScript({
      acmeCertDir: '/root/.acme.sh/*.zsaos.com_ecc',
      layout: certLayout('/tmp/launchos-cert'),
    });
    assert.match(script, /STAGING/);
    assert.match(script, /PREV/);
    assert.match(script, /cmp \/tmp\/launchos-cert-mod/);
    assert.match(script, /nginx -t/);
    assert.match(script, /ATOMIC_INSTALL_OK/);
  });

  it('rollback script restores previous and reloads', () => {
    const script = buildRollbackCertScript({
      layout: certLayout('/tmp/launchos-cert'),
    });
    assert.match(script, /PREV\/fullchain\.pem/);
    assert.match(script, /nginx -t/);
    assert.match(script, /nginx -s reload/);
    assert.match(script, /ROLLBACK_OK/);
  });
});

describe('daysUntil', () => {
  it('computes whole days', () => {
    const now = new Date('2026-09-15T00:00:00Z');
    const end = new Date('2026-09-17T00:00:00Z');
    assert.equal(daysUntil(end, now), 2);
  });
});
