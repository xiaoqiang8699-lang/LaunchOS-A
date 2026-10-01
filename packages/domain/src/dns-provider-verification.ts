import { randomBytes } from 'node:crypto';
import {
  AlibabaCloudDnsProvider,
  assertSystemDnsRootDomain,
  type TxtRecordRef,
} from './alibaba-dns-provider';
import { verifyTxtContains, waitForTxtPropagation } from './dns-txt-verify';

export type DnsConnectionTestResult = {
  ok: boolean;
  message: string;
  recordCount?: number;
  /** Sanitized API detail for advanced admin view only */
  detail?: string;
};

export type DnsTxtCrudTestStep = {
  step: string;
  ok: boolean;
  message: string;
  detail?: string;
};

export type DnsTxtCrudTestResult = {
  ok: boolean;
  message: string;
  hostname: string;
  rr: string;
  steps: DnsTxtCrudTestStep[];
  recordId?: string;
};

export async function testDnsProviderConnection(
  provider: AlibabaCloudDnsProvider,
  rootDomain: string,
): Promise<DnsConnectionTestResult> {
  assertSystemDnsRootDomain(rootDomain, rootDomain);
  try {
    const listed = await provider.listDomainRecordsReadOnly({ pageSize: 20 });
    return {
      ok: true,
      message: 'DNS 凭证验证成功',
      recordCount: listed.total,
    };
  } catch (error) {
    const detail = sanitizeApiError(error);
    return {
      ok: false,
      message: 'DNS 凭证验证失败',
      detail,
    };
  }
}

export async function runLaunchosVerifyTxtCrudTest(
  provider: AlibabaCloudDnsProvider,
  rootDomain: string,
): Promise<DnsTxtCrudTestResult> {
  assertSystemDnsRootDomain(rootDomain, rootDomain);
  const suffix = randomBytes(4).toString('hex');
  const rr = `_launchos-verify-${suffix}`;
  const hostname = `${rr}.${rootDomain}`;
  const txtValue = `launchos-verify-${randomBytes(12).toString('hex')}`;
  const steps: DnsTxtCrudTestStep[] = [];
  let recordRef: TxtRecordRef | null = null;

  try {
    recordRef = await provider.createTxtRecord(rr, txtValue);
    steps.push({
      step: 'create',
      ok: true,
      message: '测试 TXT 记录已创建',
    });
  } catch (error) {
    steps.push({
      step: 'create',
      ok: false,
      message: '创建测试 TXT 失败',
      detail: sanitizeApiError(error),
    });
    return failResult(rr, hostname, steps);
  }

  const propagated = await waitForTxtPropagation({
    hostname,
    expectedValue: txtValue,
    timeoutMs: 3 * 60 * 1000,
    intervalMs: 5_000,
  });
  steps.push({
    step: 'doh',
    ok: propagated.ok,
    message: propagated.ok ? '公网 DoH 已确认 TXT 生效' : '公网 DoH 未检测到 TXT',
    detail: propagated.ok ? undefined : `values=${propagated.values.join(',') || '(empty)'}`,
  });
  if (!propagated.ok) {
    await safeDelete(provider, recordRef);
    return failResult(rr, hostname, steps, recordRef?.recordId);
  }

  try {
    const found = await provider.findTxtRecord(rr, txtValue);
    if (!found?.recordId) {
      steps.push({
        step: 'find',
        ok: false,
        message: 'Describe 未找到匹配的 recordId',
      });
      await safeDelete(provider, recordRef);
      return failResult(rr, hostname, steps, recordRef?.recordId);
    }
    steps.push({
      step: 'find',
      ok: true,
      message: '已确认 recordId',
    });
    recordRef = found;
  } catch (error) {
    steps.push({
      step: 'find',
      ok: false,
      message: '查询 recordId 失败',
      detail: sanitizeApiError(error),
    });
    await safeDelete(provider, recordRef);
    return failResult(rr, hostname, steps, recordRef?.recordId);
  }

  try {
    await provider.deleteTxtRecord(recordRef.recordId, txtValue);
    steps.push({
      step: 'delete',
      ok: true,
      message: '已按 recordId 删除测试 TXT',
    });
  } catch (error) {
    steps.push({
      step: 'delete',
      ok: false,
      message: '删除测试 TXT 失败',
      detail: sanitizeApiError(error),
    });
    return failResult(rr, hostname, steps, recordRef.recordId);
  }

  const gone = await waitForTxtGone(hostname, txtValue);
  steps.push({
    step: 'doh-gone',
    ok: gone.ok,
    message: gone.ok ? '公网 DoH 已确认 TXT 消失' : '公网 DoH 仍检测到 TXT',
    detail: gone.ok ? undefined : `values=${gone.values.join(',') || '(empty)'}`,
  });

  if (!gone.ok) {
    return failResult(rr, hostname, steps, recordRef.recordId);
  }

  return {
    ok: true,
    message: '受控 TXT CRUD 测试通过',
    hostname,
    rr,
    steps,
    recordId: recordRef.recordId,
  };
}

async function waitForTxtGone(
  hostname: string,
  previousValue: string,
): Promise<{ ok: boolean; values: string[] }> {
  const deadline = Date.now() + 3 * 60 * 1000;
  let lastValues: string[] = [];
  while (Date.now() < deadline) {
    const result = await verifyTxtContains(hostname, previousValue);
    lastValues = result.values;
    if (!result.ok) {
      return { ok: true, values: lastValues };
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return { ok: false, values: lastValues };
}

async function safeDelete(
  provider: AlibabaCloudDnsProvider,
  ref: TxtRecordRef | null,
): Promise<void> {
  if (!ref?.recordId) {
    return;
  }
  try {
    await provider.deleteTxtRecord(ref.recordId, ref.value);
  } catch {
    // best-effort cleanup
  }
}

function failResult(
  rr: string,
  hostname: string,
  steps: DnsTxtCrudTestStep[],
  recordId?: string,
): DnsTxtCrudTestResult {
  return {
    ok: false,
    message: '受控 TXT CRUD 测试失败，已停止',
    hostname,
    rr,
    steps,
    recordId,
  };
}

function sanitizeApiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/accessKeySecret[=:]\s*\S+/gi, 'accessKeySecret=***')
    .replace(/AccessKeySecret[=:]\s*\S+/gi, 'AccessKeySecret=***')
    .replace(/LTAI[A-Za-z0-9]{10,}/g, (m) => `${m.slice(0, 4)}****${m.slice(-4)}`)
    .slice(0, 500);
}
