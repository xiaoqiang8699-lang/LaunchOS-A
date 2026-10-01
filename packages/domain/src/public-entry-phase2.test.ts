import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NginxGatewayProvider,
  classifyPublicEntryPortBlocker,
  GATEWAY_LAYOUT,
} from './gateway-runtime.js';
import {
  resolveCertificateMaterialFacts,
  certificateMaterialBlocker,
  planCertificateInstall,
  fingerprintCertificatePem,
} from './certificate-materializer.js';
import { planDnsARecord } from './dns-apply-plan.js';
import { detectActualWebApiEnvUsage } from './web-api-env-detect.js';
import {
  PUBLIC_ENTRY_EXECUTION_STEPS,
  dnsAllowedAfter,
  publicEntryLockKey,
} from './public-entry-orchestrator.js';
import { assertGatewayTarget, generateGatewayConfig } from './gateway-access.js';
import { filterRuntimeEnvForUnitType } from '@launchos/shared';

describe('step29 phase2 public entry engineering', () => {
  it('nginx absent → install required with apt-get', () => {
    const provider = new NginxGatewayProvider();
    const detect = provider.detectFromFacts({
      aptGetAvailable: true,
      nginxBinaryPath: null,
      nginxRunning: false,
      listeningPorts: [22],
    });
    assert.equal(detect.installRequired, true);
    assert.equal(detect.packageManager, 'apt-get');
    assert.equal(detect.packageManagerSupported, true);
    const plan = provider.planInstall(detect);
    assert.ok(plan);
    assert.equal(plan!.packageName, 'nginx');
    assert.deepEqual(plan!.publicPorts, [80, 443]);
    assert.equal(plan!.dynamicRuntimePortsPrivate, true);
  });

  it('existing nginx → idempotent no-install', () => {
    const provider = new NginxGatewayProvider();
    const detect = provider.detectFromFacts({
      aptGetAvailable: true,
      nginxBinaryPath: '/usr/sbin/nginx',
      nginxVersion: '1.24.0',
      nginxRunning: true,
      listeningPorts: [22, 80, 443],
    });
    assert.equal(detect.installRequired, false);
    assert.equal(provider.planInstall(detect), null);
  });

  it('certificate metadata valid but material missing → blocker', () => {
    const facts = resolveCertificateMaterialFacts({
      certificateId: 'cert1',
      commonName: '*.zsaos.com',
      expiresAt: '2026-12-14T23:59:59.000Z',
      coversApiHostname: true,
      coversWebHostname: true,
      presentOnTarget: false,
      presentOnSourceHost: false,
    });
    assert.equal(facts.certificateValid, true);
    assert.equal(facts.certificateMaterialAvailable, false);
    const b = certificateMaterialBlocker(facts);
    assert.ok(b);
    assert.equal(b!.code, 'CERTIFICATE_MATERIAL_UNAVAILABLE');
  });

  it('certificate material present on source → install plan ready', () => {
    const facts = resolveCertificateMaterialFacts({
      certificateId: 'cert1',
      commonName: '*.zsaos.com',
      expiresAt: '2026-12-14T23:59:59.000Z',
      coversApiHostname: true,
      coversWebHostname: true,
      presentOnTarget: false,
      presentOnSourceHost: true,
      sourceHost: '8.138.113.134',
      sourcePathHint: '/www/server/panel/vhost/cert/launchos-wildcard-zsaos',
      fullchainFingerprint: fingerprintCertificatePem('-----BEGIN CERTIFICATE-----\nABC\n'),
    });
    assert.equal(facts.certificateMaterialAvailable, true);
    assert.equal(facts.certificateInstallRequired, true);
    const plan = planCertificateInstall(facts);
    assert.ok(plan);
    assert.match(plan!.targetDir, /\/opt\/launchos\/gateway\/certificates\//);
    assert.equal(certificateMaterialBlocker(facts), null);
  });

  it('target route loopback invariant still enforced', () => {
    assert.equal(assertGatewayTarget({ targetHost: '0.0.0.0', targetPort: 39000 }).ok, false);
    assert.equal(assertGatewayTarget({ targetHost: '127.0.0.1', targetPort: 39000 }).ok, true);
  });

  it('nginx staged apply uses temp → test → atomic activate → rollback', () => {
    const provider = new NginxGatewayProvider();
    const staged = provider.planStagedApply({ configBody: 'server{}', stamp: 't1' });
    assert.match(staged.tempPath, /generated/);
    assert.equal(staged.activePath, GATEWAY_LAYOUT.includeConf);
    assert.equal(staged.testCommand, 'nginx -t');
    assert.ok(staged.activateCommands.some((c) => c.includes('.new')));
    assert.equal(staged.reloadCommand, 'nginx -s reload');
    assert.ok(staged.rollbackCommands.length > 0);
  });

  it('execution order places API route before DNS', () => {
    const apiIdx = PUBLIC_ENTRY_EXECUTION_STEPS.indexOf('create_api_gateway_route');
    const verifyIdx = PUBLIC_ENTRY_EXECUTION_STEPS.indexOf('localhost_api_gateway_verification');
    const dnsIdx = PUBLIC_ENTRY_EXECUTION_STEPS.indexOf('create_or_update_api_dns');
    assert.ok(apiIdx < verifyIdx);
    assert.ok(verifyIdx < dnsIdx);
    assert.equal(dnsAllowedAfter(['create_api_gateway_route']), false);
    assert.equal(
      dnsAllowedAfter(['create_api_gateway_route', 'localhost_api_gateway_verification']),
      true,
    );
  });

  it('detects Vite actual env usage NEXT_PUBLIC_API_URL as BUILD_TIME', () => {
    const usage = detectActualWebApiEnvUsage({
      framework: 'VITE',
      plannedWebApiUrl: 'https://api-launchos.zsaos.com',
      requirementKeys: ['NEXT_PUBLIC_API_URL'],
      files: [
        {
          path: 'apps/web/main.js',
          content: "const apiUrl = import.meta.env.NEXT_PUBLIC_API_URL || '';\n",
        },
      ],
    });
    assert.equal(usage.actualWebApiEnvKey, 'NEXT_PUBLIC_API_URL');
    assert.equal(usage.webApiConfigMode, 'BUILD_TIME');
    assert.equal(usage.webRebuildRequired, true);
    assert.ok(usage.actualWebApiEnvUsage.length >= 1);
  });

  it('BUILD_TIME public config does not leak backend secrets', () => {
    const filtered = filterRuntimeEnvForUnitType('WEB', {
      NEXT_PUBLIC_API_URL: 'https://api-launchos.zsaos.com',
      DATABASE_URL: 'postgres://u:p@h/db',
      REDIS_URL: 'redis://u:p@h:6379',
      JWT_SECRET: 'x',
    });
    assert.equal(filtered.env.DATABASE_URL, undefined);
    assert.equal(filtered.env.NEXT_PUBLIC_API_URL, 'https://api-launchos.zsaos.com');
  });

  it('DNS same target → NO_CHANGE; conflict → DNS_RECORD_CONFLICT; new → CREATE', () => {
    const same = planDnsARecord({
      hostname: 'api-launchos.zsaos.com',
      rootDomain: 'zsaos.com',
      desiredIp: '116.62.198.184',
      existing: { rr: 'api-launchos', type: 'A', value: '116.62.198.184', managedByLaunchOS: true },
    });
    assert.equal(same.action, 'NO_CHANGE');

    const conflict = planDnsARecord({
      hostname: 'api-launchos.zsaos.com',
      rootDomain: 'zsaos.com',
      desiredIp: '116.62.198.184',
      existing: { rr: 'api-launchos', type: 'A', value: '1.2.3.4', managedByLaunchOS: false },
    });
    assert.equal(conflict.action, 'DNS_RECORD_CONFLICT');

    const create = planDnsARecord({
      hostname: 'web-launchos.zsaos.com',
      rootDomain: 'zsaos.com',
      desiredIp: '116.62.198.184',
      existing: null,
    });
    assert.equal(create.action, 'CREATE');
  });

  it('SG already 22/80/443 → listener pending not SG mutation', () => {
    const r = classifyPublicEntryPortBlocker({
      securityGroupReady: true,
      listening80: false,
      listening443: false,
    });
    assert.equal(r.securityGroupChangeRequired, false);
    assert.equal(r.code, 'GATEWAY_LISTENER_PENDING');
  });

  it('dynamic ports never appear in gateway install public ports', () => {
    const provider = new NginxGatewayProvider();
    const plan = provider.planInstall(
      provider.detectFromFacts({ aptGetAvailable: true, nginxBinaryPath: null }),
    );
    assert.ok(plan);
    assert.equal(plan!.publicPorts.includes(39000), false);
    assert.equal(plan!.publicPorts.includes(3000), false);
  });

  it('builds distributed public-entry lock key', () => {
    assert.equal(
      publicEntryLockKey('proj', 'srv'),
      'public-entry:proj:srv',
    );
  });

  it('generated gateway config has HTTPS redirect', () => {
    const cfg = generateGatewayConfig({
      hostname: 'api-launchos.zsaos.com',
      targetHost: '127.0.0.1',
      targetPort: 39000,
      healthPath: '/health',
    });
    assert.match(cfg.combined, /return 301 https/);
    assert.match(cfg.combined, /127\.0\.0\.1:39000/);
  });
});
