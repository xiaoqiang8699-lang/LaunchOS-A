'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { formatDateTime } from '@/lib/project-labels';

type EligibleUnit = { id: string; name: string; type: string; required: boolean };
type Connection = {
  id: string;
  name: string;
  status: string;
  host: string;
  port: number;
  usernameConfigured: boolean;
  passwordConfigured: boolean;
  databaseIndex: number;
  tlsMode: string;
  lastTestedAt: string | null;
  lastTestLatencyMs: number | null;
  boundUnits: Array<{ id: string; name: string }>;
};

type ListPayload = {
  canEdit: boolean;
  eligibleUnits: EligibleUnit[];
  connections: Connection[];
};

type ProvisionOptions = {
  canEdit: boolean;
  suggestedRegion: string;
  suggestedInstanceName: string;
  billingNotice: string;
  costHint: string;
  billingExtraValidationNotice?: string;
  firstUseNotice?: string;
  eligibleUnits: EligibleUnit[];
  tiers: Array<{
    tier: string;
    label: string;
    instanceClass: string;
    engineVersion?: string;
    capacityMb?: number;
  }>;
  productSummary?: {
    title: string;
    capacityLabel: string | null;
    chargeType: string;
    estimatedHourlyPrice: string | null;
    currency: string | null;
  } | null;
  priceEstimate?: {
    available?: boolean;
    currency?: string | null;
    tradePrice?: string | null;
    hourlyPrice?: string | null;
    billingCycle?: string | null;
  } | null;
  billingReadiness?: {
    status?: string;
    reason?: string;
    canConfirmSufficientBalance?: boolean;
    minimumBalanceRequirement?: string;
  } | null;
};

type ProvisionStatus = {
  id: string;
  status: string;
  statusRaw?: string;
  phase: string;
  phaseLabel: string;
  currentAction?: string;
  steps: Array<{ key: string; label: string; status: string }>;
  region: string | null;
  tier: string | null;
  errorMessage: string | null;
  providerResourceId?: string | null;
  canRetry?: boolean;
  elapsedSeconds?: number;
  lastActivityLabel?: string | null;
  staleStepHint?: string | null;
  redisConnectionId: string | null;
};

function isProvisioningInFlight(status: ProvisionStatus | null): boolean {
  if (!status) return false;
  return (
    status.statusRaw === 'CREATING' ||
    status.status === '正在创建' ||
    status.status === '等待开始' ||
    status.status === '创建服务暂不可用'
  );
}

const emptyForm = {
  name: '主 Redis',
  host: '',
  port: 6379,
  username: '',
  password: '',
  databaseIndex: 0,
  tlsMode: 'DISABLE',
  unitIds: [] as string[],
};

export default function ProjectRedisPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [payload, setPayload] = useState<ListPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [provisionOptions, setProvisionOptions] = useState<ProvisionOptions | null>(null);
  const [provision, setProvision] = useState<ProvisionStatus | null>(null);
  const [confirmBilling, setConfirmBilling] = useState(false);
  const [tier, setTier] = useState('DEV');
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    latencyMs?: number;
  } | null>(null);

  const load = useCallback(async () => {
    const data = await api<ListPayload>(`/projects/${params.id}/redis-connections`);
    setPayload(data);
    if (data.eligibleUnits.length > 0 && form.unitIds.length === 0) {
      setForm((prev) => ({
        ...prev,
        unitIds: data.eligibleUnits.filter((u) => u.required).map((u) => u.id),
      }));
    }
    try {
      const opt = await api<ProvisionOptions>(`/projects/${params.id}/redis-provisions/options`);
      setProvisionOptions(opt);
      const list = await api<{ resources: ProvisionStatus[] }>(
        `/projects/${params.id}/redis-provisions`,
      );
      const active =
        list.resources.find((r) => r.statusRaw === 'CREATING' || r.statusRaw === 'RUNNING') ||
        list.resources.find((r) => r.statusRaw === 'FAILED') ||
        list.resources[0] ||
        null;
      setProvision(active);
    } catch {
      // provision APIs optional if not ready
    }
  }, [params.id, form.unitIds.length]);

  useEffect(() => {
    if (!isProvisioningInFlight(provision)) return;
    const timer = setInterval(() => {
      if (!provision) return;
      void api<ProvisionStatus>(`/projects/${params.id}/redis-provisions/${provision.id}`)
        .then((next) => {
          setProvision(next);
          if (next.status === '可用') {
            setFeedback('Redis 已连接。重新上线后生效。');
            void load();
          }
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [provision, params.id, load]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await load();
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearAccessToken();
          router.replace('/login');
          return;
        }
        setError(err instanceof Error ? err.message : '加载失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, router]);

  async function createManagedRedis(): Promise<void> {
    if (!confirmBilling) {
      setError('请确认将在阿里云账号产生费用');
      return;
    }
    setBusy('provision');
    setError(null);
    try {
      const unitIds =
        form.unitIds.length > 0
          ? form.unitIds
          : (payload?.eligibleUnits || []).filter((u) => u.required).map((u) => u.id);
      const created = await api<ProvisionStatus>(`/projects/${params.id}/redis-provisions`, {
        method: 'POST',
        body: JSON.stringify({
          tier,
          unitIds,
          confirmBilling: true,
          confirmReplaceManual: true,
        }),
      });
      setProvision(created);
      setFeedback('正在创建 Redis…');
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setBusy(null);
    }
  }

  async function retryProvision(): Promise<void> {
    if (!provision) return;
    setBusy('retry');
    try {
      const next = await api<ProvisionStatus>(
        `/projects/${params.id}/redis-provisions/${provision.id}/retry`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setProvision(next);
      setFeedback(
        provision.providerResourceId
          ? '继续完成 Redis 配置…'
          : '正在重试创建 Redis…',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '重试失败');
    } finally {
      setBusy(null);
    }
  }

  async function testConnection(): Promise<void> {
    setBusy('test');
    setError(null);
    setTestResult(null);
    try {
      const result = await api<{
        success: boolean;
        message: string;
        latencyMs: number;
      }>(`/projects/${params.id}/redis-connections/test`, {
        method: 'POST',
        body: JSON.stringify({
          host: form.host,
          port: form.port,
          username: form.username || undefined,
          password: form.password || undefined,
          databaseIndex: form.databaseIndex,
          tlsMode: form.tlsMode,
          testLocation: 'AUTO',
        }),
      });
      setTestResult({
        success: result.success,
        message: result.message,
        latencyMs: result.latencyMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '测试失败';
      setTestResult({ success: false, message });
      setError(message);
    } finally {
      setBusy(null);
    }
  }

  async function save(): Promise<void> {
    if (!payload?.canEdit) {
      setError('仅管理员可以管理 Redis 连接');
      return;
    }
    setBusy('save');
    setError(null);
    setFeedback(null);
    try {
      await api(`/projects/${params.id}/redis-connections`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          host: form.host,
          port: form.port,
          username: form.username || undefined,
          password: form.password || undefined,
          databaseIndex: form.databaseIndex,
          tlsMode: form.tlsMode,
          unitIds: form.unitIds,
          testLocation: 'AUTO',
          confirmReplaceManual: true,
        }),
      });
      setFeedback('Redis 连接已保存，重新上线后生效。');
      setForm((prev) => ({ ...prev, password: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(null);
    }
  }

  async function remove(connection: Connection): Promise<void> {
    try {
      const impact = await api<{
        message: string;
        affectedUnits: Array<{ name: string }>;
      }>(`/projects/${params.id}/redis-connections/${connection.id}/delete-impact`);
      const names = impact.affectedUnits.map((u) => u.name).join('、');
      if (
        !window.confirm(
          `${impact.message}\n${names || '无'}\n\n当前运行实例不会立即停止。确认删除？`,
        )
      ) {
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法获取删除影响');
      return;
    }
    setBusy(`del:${connection.id}`);
    try {
      await api(`/projects/${params.id}/redis-connections/${connection.id}`, {
        method: 'DELETE',
      });
      setFeedback('Redis 连接已删除。');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(null);
    }
  }

  if (!payload) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        {error ?? '加载中…'}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link className="text-sm text-zinc-500" href={`/projects/${params.id}`}>
            ← 返回应用
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">Redis</h1>
          <p className="mt-1 text-sm text-zinc-500">
            可连接已有 Redis，或让 LaunchOS 在阿里云自动创建。
          </p>
          <p className="mt-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600">
            已整合到{' '}
            <Link className="font-medium text-zinc-900 underline" href={`/projects/${params.id}/dependencies`}>
              应用依赖
            </Link>
            。本页保留给高级管理与既有测试脚本。
          </p>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {feedback ? <p className="text-sm text-emerald-700">{feedback}</p> : null}

        {provisionOptions && payload.canEdit && payload.eligibleUnits.length > 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <h2 className="text-sm font-medium text-zinc-500">LaunchOS 帮我创建 Redis</h2>
            <p className="mt-1 text-xs text-zinc-500">{provisionOptions.billingNotice}</p>
            {provisionOptions.firstUseNotice ? (
              <p className="mt-1 text-xs text-amber-700">{provisionOptions.firstUseNotice}</p>
            ) : null}
            {!provision || provision.statusRaw === 'DELETED' ? (
              <div className="mt-3 grid gap-3">
                {provisionOptions.productSummary ? (
                  <div className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
                    <p className="font-medium text-zinc-900">
                      {provisionOptions.productSummary.title}
                    </p>
                    <p className="mt-1">
                      规格：{provisionOptions.productSummary.capacityLabel || '按所选规格'}
                    </p>
                    <p>计费：{provisionOptions.productSummary.chargeType}</p>
                    <p>
                      预计：
                      {provisionOptions.productSummary.estimatedHourlyPrice
                        ? `${
                            provisionOptions.productSummary.currency === 'CNY' ||
                            !provisionOptions.productSummary.currency
                              ? '¥'
                              : provisionOptions.productSummary.currency
                          }${provisionOptions.productSummary.estimatedHourlyPrice} / 小时（来自 DescribePrice）`
                        : '价格待查询'}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">阿里云实际扣费为准</p>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">{provisionOptions.costHint}</p>
                )}
                {provisionOptions.billingExtraValidationNotice ? (
                  <p className="text-xs text-amber-700">
                    {provisionOptions.billingExtraValidationNotice}
                  </p>
                ) : null}
                <label className="text-sm text-zinc-700">
                  规格
                  <select
                    className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                    value={tier}
                    onChange={(e) => setTier(e.target.value)}
                  >
                    {(provisionOptions.tiers || []).map((item) => (
                      <option key={item.tier} value={item.tier}>
                        {item.label} · {item.instanceClass}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input
                    type="checkbox"
                    checked={confirmBilling}
                    onChange={(e) => setConfirmBilling(e.target.checked)}
                  />
                  我确认将在阿里云账号产生费用
                </label>
                <button
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-60"
                  type="button"
                  disabled={busy === 'provision'}
                  onClick={() => void createManagedRedis()}
                >
                  {busy === 'provision' ? '提交中…' : '创建阿里云 Redis'}
                </button>
              </div>
            ) : (
              <div className="mt-3">
                <p className="text-sm text-zinc-800">
                  状态：{provision.status} · {provision.currentAction || provision.phaseLabel}
                </p>
                {isProvisioningInFlight(provision) ? (
                  <p className="mt-1 text-xs text-zinc-500">
                    已运行 {provision.elapsedSeconds ?? 0} 秒
                    {provision.lastActivityLabel
                      ? ` · 最近活动：${provision.lastActivityLabel}`
                      : ''}
                  </p>
                ) : null}
                {provision.staleStepHint ? (
                  <p className="mt-1 text-xs text-amber-700">{provision.staleStepHint}</p>
                ) : null}
                <ul className="mt-3 space-y-1 text-sm text-zinc-600">
                  {provision.steps.map((step) => (
                    <li key={step.key}>
                      {step.status === 'done'
                        ? '✓'
                        : step.status === 'running'
                          ? '…'
                          : step.status === 'failed'
                            ? '✗'
                            : '○'}{' '}
                      {step.label}
                    </li>
                  ))}
                </ul>
                {provision.errorMessage ? (
                  <p className="mt-2 text-sm text-red-600">{provision.errorMessage}</p>
                ) : null}
                {provision.canRetry ? (
                  <button
                    className="mt-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700"
                    type="button"
                    disabled={busy === 'retry'}
                    onClick={() => void retryProvision()}
                  >
                    {provision.providerResourceId
                      ? '继续完成 Redis 配置'
                      : '重试创建'}
                  </button>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        {payload.connections.map((connection) => (
          <section key={connection.id} className="rounded-2xl border border-zinc-200 bg-white p-5">
            <p className="font-medium text-zinc-900">{connection.name}</p>
            <p className="mt-1 text-sm text-zinc-600">
              Redis · {connection.status === 'CONNECTED' ? '已连接' : connection.status}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              {connection.host}:{connection.port} / db {connection.databaseIndex}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              {connection.passwordConfigured ? '密码已保存' : '无密码'} · 绑定：
              {connection.boundUnits.map((u) => u.name).join('、') || '无'}
            </p>
            {connection.lastTestedAt ? (
              <p className="mt-1 text-xs text-zinc-500">
                最近检测：{formatDateTime(connection.lastTestedAt)}
                {connection.lastTestLatencyMs != null
                  ? ` · ${connection.lastTestLatencyMs}ms`
                  : ''}
              </p>
            ) : null}
            {payload.canEdit ? (
              <button
                className="mt-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700"
                type="button"
                disabled={busy === `del:${connection.id}`}
                onClick={() => void remove(connection)}
              >
                删除连接
              </button>
            ) : null}
          </section>
        ))}

        {payload.canEdit && payload.eligibleUnits.length > 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <h2 className="text-sm font-medium text-zinc-500">连接 Redis</h2>
            <div className="mt-3 grid gap-3">
              <label className="text-sm text-zinc-700">
                名称
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                />
              </label>
              <label className="text-sm text-zinc-700">
                Redis 地址
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  value={form.host}
                  onChange={(e) => setForm((prev) => ({ ...prev, host: e.target.value }))}
                  placeholder="redis.example.com"
                />
              </label>
              <label className="text-sm text-zinc-700">
                端口
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  type="number"
                  value={form.port}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, port: Number(e.target.value) || 6379 }))
                  }
                />
              </label>
              <label className="text-sm text-zinc-700">
                用户名（可选）
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  value={form.username}
                  onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
                  autoComplete="off"
                />
              </label>
              <label className="text-sm text-zinc-700">
                密码（可选）
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                  autoComplete="new-password"
                />
              </label>
              <label className="text-sm text-zinc-700">
                数据库编号
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  type="number"
                  value={form.databaseIndex}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      databaseIndex: Math.max(0, Number(e.target.value) || 0),
                    }))
                  }
                />
              </label>
              <label className="text-sm text-zinc-700">
                TLS
                <select
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  value={form.tlsMode}
                  onChange={(e) => setForm((prev) => ({ ...prev, tlsMode: e.target.value }))}
                >
                  <option value="AUTO">自动</option>
                  <option value="REQUIRE">需要 TLS</option>
                  <option value="DISABLE">不使用 TLS</option>
                </select>
              </label>
              <div>
                <p className="text-sm text-zinc-700">绑定到组成</p>
                <div className="mt-2 space-y-2">
                  {payload.eligibleUnits.map((unit) => (
                    <label key={unit.id} className="flex items-center gap-2 text-sm text-zinc-700">
                      <input
                        type="checkbox"
                        checked={form.unitIds.includes(unit.id)}
                        onChange={(e) => {
                          setForm((prev) => ({
                            ...prev,
                            unitIds: e.target.checked
                              ? [...prev.unitIds, unit.id]
                              : prev.unitIds.filter((id) => id !== unit.id),
                          }));
                        }}
                      />
                      {unit.name}
                      {unit.required ? '（必填）' : ''}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {testResult ? (
              <p
                className={`mt-3 text-sm ${testResult.success ? 'text-emerald-700' : 'text-red-600'}`}
              >
                {testResult.message}
                {testResult.latencyMs != null ? ` · ${testResult.latencyMs}ms` : ''}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 disabled:opacity-60"
                type="button"
                disabled={busy === 'test'}
                onClick={() => void testConnection()}
              >
                {busy === 'test' ? '测试中…' : '测试连接'}
              </button>
              <button
                className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-60"
                type="button"
                disabled={busy === 'save'}
                onClick={() => void save()}
              >
                {busy === 'save' ? '保存中…' : '保存 Redis 连接'}
              </button>
            </div>
          </section>
        ) : null}

        {payload.eligibleUnits.length === 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5 text-sm text-zinc-600">
            当前应用没有需要 REDIS_URL 的组成。
          </section>
        ) : null}
      </div>
    </main>
  );
}
