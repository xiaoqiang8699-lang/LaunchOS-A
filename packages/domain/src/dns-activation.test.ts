import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planDnsARecord } from './dns-apply-plan.js';
import {
  STEP29_PHASE3B_BASELINE,
  DNS_ACTIVATION_EXECUTION_STEPS,
  reconcileDnsCreateAttempt,
  dnsPartialApplyState,
  dnsPropagationStrategy,
  planApiPublicHttpsVerify,
  planWebPublicHttpsVerify,
  planHttpRedirectVerifies,
  planGatewayRouteActivation,
  canMarkAccessEntryActive,
  evaluateDnsActivationGate,
  buildDnsOwnershipFromPlan,
} from './dns-activation.js';
import { ALIYUN_DNS_DEFAULT_TTL } from './alibaba-dns-provider.js';

describe('step29 phase3b dns activation gate engineering', () => {
  it('DNS missing → CREATE', () => {
    const plan = planDnsARecord({
      hostname: STEP29_PHASE3B_BASELINE.api.hostname,
      rootDomain: STEP29_PHASE3B_BASELINE.rootDomain,
      desiredIp: STEP29_PHASE3B_BASELINE.publicIp,
      existing: null,
    });
    assert.equal(plan.action, 'CREATE');
    assert.equal(plan.managedByLaunchOS, true);
  });

  it('same record → NO_CHANGE', () => {
    const plan = planDnsARecord({
      hostname: STEP29_PHASE3B_BASELINE.web.hostname,
      rootDomain: STEP29_PHASE3B_BASELINE.rootDomain,
      desiredIp: STEP29_PHASE3B_BASELINE.publicIp,
      existing: {
        rr: 'web-launchos',
        type: 'A',
        value: STEP29_PHASE3B_BASELINE.publicIp,
        recordId: 'r1',
        managedByLaunchOS: true,
      },
    });
    assert.equal(plan.action, 'NO_CHANGE');
  });

  it('LaunchOS-owned wrong value → UPDATE', () => {
    const plan = planDnsARecord({
      hostname: STEP29_PHASE3B_BASELINE.api.hostname,
      rootDomain: STEP29_PHASE3B_BASELINE.rootDomain,
      desiredIp: STEP29_PHASE3B_BASELINE.publicIp,
      existing: {
        rr: 'api-launchos',
        type: 'A',
        value: '1.1.1.1',
        recordId: 'r2',
        managedByLaunchOS: true,
      },
    });
    assert.equal(plan.action, 'UPDATE');
  });

  it('unknown-owner wrong value → CONFLICT', () => {
    const plan = planDnsARecord({
      hostname: STEP29_PHASE3B_BASELINE.api.hostname,
      rootDomain: STEP29_PHASE3B_BASELINE.rootDomain,
      desiredIp: STEP29_PHASE3B_BASELINE.publicIp,
      existing: {
        rr: 'api-launchos',
        type: 'A',
        value: '1.1.1.1',
        recordId: 'r3',
        managedByLaunchOS: false,
      },
    });
    assert.equal(plan.action, 'DNS_RECORD_CONFLICT');
  });

  it('timeout after CREATE → reconcile as ALREADY_CORRECT (no duplicate)', () => {
    const r = reconcileDnsCreateAttempt({
      hostname: STEP29_PHASE3B_BASELINE.api.hostname,
      rootDomain: STEP29_PHASE3B_BASELINE.rootDomain,
      desiredIp: STEP29_PHASE3B_BASELINE.publicIp,
      providerRecords: [
        {
          rr: 'api-launchos',
          type: 'A',
          value: STEP29_PHASE3B_BASELINE.publicIp,
          recordId: 'created-1',
          managedByLaunchOS: true,
        },
      ],
    });
    assert.equal(r.outcome, 'ALREADY_CORRECT');
  });

  it('API success + Web fail → partial state, never ACTIVE', () => {
    const partial = dnsPartialApplyState({ apiDnsApplied: true, webDnsApplied: false });
    assert.equal(partial.status, 'PARTIAL');
    assert.equal(partial.accessEntryActive, false);
    assert.equal(partial.apiDnsApplied, true);
    assert.equal(partial.webDnsApplied, false);
  });

  it('propagation strategy has finite timeout code', () => {
    const s = dnsPropagationStrategy(STEP29_PHASE3B_BASELINE.publicIp);
    assert.equal(s.timeoutCode, 'DNS_PROPAGATION_TIMEOUT');
    assert.ok(s.timeoutMs >= 5 * 60 * 1000 && s.timeoutMs <= 10 * 60 * 1000);
    assert.equal(s.checkAuthoritative, true);
    assert.equal(s.checkPublicResolvers, true);
  });

  it('HTTPS verification failure keeps Access Entry off ACTIVE', () => {
    const r = canMarkAccessEntryActive({
      apiDnsPropagated: true,
      webDnsPropagated: true,
      apiPublicHttpsVerified: false,
      webPublicHttpsVerified: true,
      httpToHttpsRedirectVerified: true,
      certificateValid: true,
      apiHealthy: true,
      webHealthy: true,
      dynamicPortsRemainPrivate: true,
    });
    assert.equal(r.ok, false);
    assert.notEqual(r.accessEntryStatus, 'ACTIVE');
  });

  it('both public HTTPS verified → ACTIVE', () => {
    const r = canMarkAccessEntryActive({
      apiDnsPropagated: true,
      webDnsPropagated: true,
      apiPublicHttpsVerified: true,
      webPublicHttpsVerified: true,
      httpToHttpsRedirectVerified: true,
      certificateValid: true,
      apiHealthy: true,
      webHealthy: true,
      dynamicPortsRemainPrivate: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.accessEntryStatus, 'ACTIVE');
  });

  it('GatewayRoute independent ACTIVE state', () => {
    const one = planGatewayRouteActivation({
      apiPublicHttpsVerified: true,
      webPublicHttpsVerified: false,
    });
    assert.equal(one.apiGatewayRouteStatus, 'ACTIVE');
    assert.equal(one.webGatewayRouteStatus, 'CONFIGURING');
  });

  it('gate blocks CONFLICT and early ACTIVE invariants', () => {
    const gate = evaluateDnsActivationGate({
      gatewayRunning: true,
      port80Listening: true,
      port443Listening: true,
      certificateValid: true,
      certificateCoversApi: true,
      certificateCoversWeb: true,
      apiLocalHttpsReady: true,
      webLocalHttpsReady: true,
      apiServiceHealthy: true,
      webServiceHealthy: true,
      dnsAccountReady: true,
      apiDnsAction: 'DNS_RECORD_CONFLICT',
      webDnsAction: 'CREATE',
      publicEntryLockReady: true,
      dynamicPortsRemainPrivate: true,
    });
    assert.equal(gate.canActivateDns, false);
    assert.ok(gate.blockers.some((b) => b.code === 'DNS_RECORD_CONFLICT'));
  });

  it('ownership record + planned TTL 600', () => {
    const plan = planDnsARecord({
      hostname: STEP29_PHASE3B_BASELINE.api.hostname,
      rootDomain: STEP29_PHASE3B_BASELINE.rootDomain,
      desiredIp: STEP29_PHASE3B_BASELINE.publicIp,
      existing: null,
    });
    const own = buildDnsOwnershipFromPlan(plan);
    assert.equal(own.ttl, ALIYUN_DNS_DEFAULT_TTL);
    assert.equal(own.managedByLaunchOS, true);
    assert.equal(own.recordType, 'A');
  });

  it('execution order DNS before public verify before ACTIVE', () => {
    const applyIdx = DNS_ACTIVATION_EXECUTION_STEPS.indexOf('apply_api_dns');
    const propIdx = DNS_ACTIVATION_EXECUTION_STEPS.indexOf('dns_propagation_check');
    const httpsIdx = DNS_ACTIVATION_EXECUTION_STEPS.indexOf('verify_api_public_https');
    const activeIdx = DNS_ACTIVATION_EXECUTION_STEPS.indexOf('mark_access_entry_active');
    assert.ok(applyIdx < propIdx);
    assert.ok(propIdx < httpsIdx);
    assert.ok(httpsIdx < activeIdx);
  });

  it('public verify + redirect plans target Phase 3B hostnames', () => {
    const api = planApiPublicHttpsVerify();
    const web = planWebPublicHttpsVerify();
    const redirects = planHttpRedirectVerifies();
    assert.match(api.url, /api-launchos\.zsaos\.com\/health/);
    assert.match(web.url, /web-launchos\.zsaos\.com/);
    assert.equal(redirects.length, 2);
    assert.match(redirects[0]!.httpUrl, /^http:\/\//);
    assert.match(redirects[0]!.httpsUrl, /^https:\/\//);
  });

  it('dynamic ports / SG invariants encoded in baseline', () => {
    assert.equal(STEP29_PHASE3B_BASELINE.web.targetPort, 39002);
    assert.equal(STEP29_PHASE3B_BASELINE.api.targetPort, 39000);
    assert.notEqual(STEP29_PHASE3B_BASELINE.web.targetPort, 39000);
  });
});
