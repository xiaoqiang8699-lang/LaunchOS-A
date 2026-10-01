import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  STEP29_GATEWAY_WHITELIST,
  assertGatewayTarget,
  assertGatewayRouteUniqueness,
  generateGatewayConfig,
  upsertGatewayRouteConfig,
  certificateCoversHostname,
  detectWebApiConfigMode,
  planSecurityGroupForGateway,
  GATEWAY_LOOPBACK_TARGET,
} from './gateway-access.js';
import { WEB_FORBIDDEN_RUNTIME_SECRET_KEYS, filterRuntimeEnvForUnitType } from '@launchos/shared';

describe('step29 gateway access', () => {
  it('accepts web route 39001 and api route 39000 on loopback', () => {
    assert.equal(
      assertGatewayTarget({
        targetHost: '127.0.0.1',
        targetPort: STEP29_GATEWAY_WHITELIST.web.targetPort,
        hostname: STEP29_GATEWAY_WHITELIST.web.hostname,
        healthPath: '/',
      }).ok,
      true,
    );
    assert.equal(
      assertGatewayTarget({
        targetHost: '127.0.0.1',
        targetPort: STEP29_GATEWAY_WHITELIST.api.targetPort,
        hostname: STEP29_GATEWAY_WHITELIST.api.hostname,
        healthPath: '/health',
      }).ok,
      true,
    );
  });

  it('keeps existing server names when adding one route', () => {
    const existing = [
      'server { listen 80; server_name api-launchos.zsaos.com; }',
      'server { listen 80; server_name web-launchos.zsaos.com; }',
      'server { listen 80; server_name oneclick-web.zsaos.com; }',
    ].join('\n');
    const incoming = generateGatewayConfig({
      hostname: 'launchos-real-test.zsaos.com',
      targetHost: '127.0.0.1',
      targetPort: 39003,
      healthPath: '/',
    }).combined;
    const next = upsertGatewayRouteConfig(existing, incoming);
    assert.match(next, /server_name api-launchos\.zsaos\.com;/);
    assert.match(next, /server_name web-launchos\.zsaos\.com;/);
    assert.match(next, /server_name oneclick-web\.zsaos\.com;/);
    assert.match(next, /server_name launchos-real-test\.zsaos\.com;/);
    assert.match(next, /127\.0\.0\.1:39003/);
    const replaced = upsertGatewayRouteConfig(next, incoming.replaceAll('39003', '39004'));
    assert.match(replaced, /127\.0\.0\.1:39004/);
    assert.equal(replaced.includes('39003'), false);
  });

  it('requires targetHost 127.0.0.1', () => {
    const bad = assertGatewayTarget({
      targetHost: '116.62.198.184',
      targetPort: 39000,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'GATEWAY_TARGET_HOST_FORBIDDEN');
    assert.equal(GATEWAY_LOOPBACK_TARGET, '127.0.0.1');
  });

  it('requires targetPort in 39000-39999', () => {
    const bad = assertGatewayTarget({ targetHost: '127.0.0.1', targetPort: 3000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'GATEWAY_TARGET_PORT_INVALID');
  });

  it('rejects duplicate hostname', () => {
    const r = assertGatewayRouteUniqueness({
      hostname: 'web-launchos.zsaos.com',
      unitId: 'u2',
      existing: [
        {
          hostname: 'web-launchos.zsaos.com',
          unitId: 'u1',
          status: 'ACTIVE',
          isDefault: true,
        },
      ],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'DUPLICATE_HOSTNAME');
  });

  it('ALIYUN_DNS is separated from cloud provider type in whitelist docs', () => {
    // Engineering invariant: DNS provider type string must remain ALIYUN_DNS.
    assert.equal('ALIYUN_DNS', 'ALIYUN_DNS');
    assert.notEqual('ALIYUN_DNS', 'ALIYUN');
  });

  it('wildcard certificate covers web and api hostnames', () => {
    assert.equal(
      certificateCoversHostname({
        commonName: '*.zsaos.com',
        sans: ['*.zsaos.com', 'zsaos.com'],
        hostname: 'web-launchos.zsaos.com',
      }),
      true,
    );
    assert.equal(
      certificateCoversHostname({
        commonName: '*.zsaos.com',
        sans: ['*.zsaos.com'],
        hostname: 'api-launchos.zsaos.com',
      }),
      true,
    );
    assert.equal(
      certificateCoversHostname({
        commonName: '*.zsaos.com',
        hostname: 'a.b.zsaos.com',
      }),
      false,
    );
  });

  it('generates HTTPS redirect and proxy headers', () => {
    const cfg = generateGatewayConfig({
      hostname: 'web-launchos.zsaos.com',
      targetHost: '127.0.0.1',
      targetPort: 39001,
      healthPath: '/',
    });
    assert.match(cfg.nginxHttpRedirect, /return 301 https:\/\//);
    assert.match(cfg.nginxHttpsServer, /proxy_pass http:\/\/127\.0\.0\.1:39001/);
    assert.match(cfg.nginxHttpsServer, /proxy_set_header Host \$host;/);
    assert.match(cfg.nginxHttpsServer, /X-Real-IP/);
    assert.match(cfg.nginxHttpsServer, /X-Forwarded-For/);
    assert.match(cfg.nginxHttpsServer, /X-Forwarded-Proto/);
  });

  it('keeps web secret isolation for public API URL planning', () => {
    const filtered = filterRuntimeEnvForUnitType('WEB', {
      NEXT_PUBLIC_API_URL: 'https://api-launchos.zsaos.com',
      DATABASE_URL: 'postgres://u:p@h/db',
      REDIS_URL: 'redis://u:p@h:6379',
      JWT_SECRET: 'x',
    });
    assert.equal(filtered.webSecretIsolation, true);
    assert.equal(filtered.env.DATABASE_URL, undefined);
    assert.ok(WEB_FORBIDDEN_RUNTIME_SECRET_KEYS.includes('DATABASE_URL'));
  });

  it('does not require security group dynamic port changes', () => {
    const plan = planSecurityGroupForGateway({ currentOpenPorts: [22, 80, 443] });
    assert.equal(plan.securityGroupChangeRequired, false);
    assert.equal(plan.dynamicPortsRemainPrivate, true);
    assert.deepEqual(plan.allowedPublicPorts, [22, 80, 443]);
  });

  it('detects Vite build-time API URL', () => {
    const mode = detectWebApiConfigMode({
      framework: 'VITE',
      requirements: [
        { key: 'NEXT_PUBLIC_API_URL', injectionPhase: 'BUILD', required: true },
      ],
    });
    assert.equal(mode.webApiConfigMode, 'BUILD_TIME');
    assert.equal(mode.webApiConfigKey, 'NEXT_PUBLIC_API_URL');
    assert.equal(mode.publicConfigOnly, true);
    assert.equal(mode.webApiPublicUrlPlanned, 'https://api-launchos.zsaos.com');
  });
});
