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
  engine: string;
  status: string;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  passwordConfigured: boolean;
  sslMode: string;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastTestLatencyMs: number | null;
  lastTestLocation: string | null;
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
  suggestedDatabaseName: string;
  billingNotice: string;
  costHint: string;
  eligibleUnits: EligibleUnit[];
  tiers: Array<{ tier: string; label: string; instanceClass: string; storageGb: number }>;
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
  databaseName: string | null;
  errorMessage: string | null;
  errorCode?: string | null;
  providerErrorCode?: string | null;
  providerRequestId?: string | null;
  providerResourceId?: string | null;
  canRetry?: boolean;
  queueHint?: string | null;
  elapsedSeconds?: number;
  lastActivityLabel?: string | null;
  staleStepHint?: string | null;
  updatedAt?: string;
  databaseConnectionId: string | null;
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

function formatElapsed(seconds?: number): string {
  if (seconds == null || seconds < 0) return '';
  if (seconds < 60) return `已运行 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `已运行 ${minutes} 分 ${rem} 秒` : `已运行 ${minutes} 分钟`;
}

const emptyForm = {
  name: '主数据库',
  host: '',
  port: 5432,
  databaseName: '',
  username: '',
  password: '',
  sslMode: 'AUTO',
  unitIds: [] as string[],
};

export default function ProjectDatabasePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [payload, setPayload] = useState<ListPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [mode, setMode] = useState<'existing' | 'create'>('existing');
  const [options, setOptions] = useState<ProvisionOptions | null>(null);
  const [provision, setProvision] = useState<ProvisionStatus | null>(null);
  const [retryWatchId, setRetryWatchId] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [createForm, setCreateForm] = useState({
    tier: 'DEV',
    region: '',
    databaseName: '',
    unitIds: [] as string[],
    confirmBilling: false,
  });
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    latencyMs?: number;
    location?: string;
  } | null>(null);

  const load = useCallback(async () => {
    const data = await api<ListPayload>(`/projects/${params.id}/database-connections`);
    setPayload(data);
    if (data.eligibleUnits.length > 0 && form.unitIds.length === 0) {
      setForm((prev) => ({
        ...prev,
        unitIds: data.eligibleUnits.filter((u) => u.required).map((u) => u.id),
      }));
    }
    try {
      const opt = await api<ProvisionOptions>(`/projects/${params.id}/database-provisions/options`);
      setOptions(opt);
      setCreateForm((prev) => ({
        ...prev,
        region: prev.region || opt.suggestedRegion,
        databaseName: prev.databaseName || opt.suggestedDatabaseName,
        unitIds:
          prev.unitIds.length > 0
            ? prev.unitIds
            : opt.eligibleUnits.filter((u) => u.required).map((u) => u.id),
      }));
      const listed = await api<{ resources: ProvisionStatus[] }>(
        `/projects/${params.id}/database-provisions`,
      );
      const active = listed.resources.find(
        (item) => item.status === '正在创建' || item.status === '可用' || item.status === '创建失败',
      );
      if (active) setProvision(active);
    } catch {
      // options may fail without Aliyun account
    }
  }, [params.id, form.unitIds.length]);

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

  useEffect(() => {
    const shouldPoll =
      isProvisioningInFlight(provision) ||
      (retryWatchId != null && provision?.id === retryWatchId && provision.status !== '可用');
    if (!provision || !shouldPoll) return;
    if (provision.status === '创建失败' && retryWatchId === provision.id) {
      // Keep one more refresh cycle handled below; stop sticky retry banner via status.
    }
    const timer = setInterval(() => {
      void api<ProvisionStatus>(`/projects/${params.id}/database-provisions/${provision.id}`)
        .then((status) => {
          setProvision(status);
          if (status.status === '可用') {
            setFeedback('数据库已连接。重新上线后生效。');
            setRetryWatchId(null);
            void load();
          } else if (status.status === '创建失败') {
            setFeedback(null);
            setRetryWatchId(null);
          } else if (status.status === '等待开始') {
            setFeedback(status.currentAction || status.phaseLabel || '等待重试任务开始…');
          } else if (isProvisioningInFlight(status)) {
            setFeedback(status.currentAction || status.phaseLabel || '正在创建数据库…');
          }
        })
        .catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [provision, params.id, load, retryWatchId]);

  async function startProvision(): Promise<void> {
    if (!createForm.confirmBilling) {
      setError('请确认将在阿里云账号产生费用');
      return;
    }
    setBusy('provision');
    setError(null);
    setPermissionDenied(false);
    try {
      const created = await api<ProvisionStatus>(`/projects/${params.id}/database-provisions`, {
        method: 'POST',
        body: JSON.stringify({
          tier: createForm.tier,
          region: createForm.region,
          databaseName: createForm.databaseName,
          unitIds: createForm.unitIds,
          confirmBilling: true,
          confirmReplaceManual: true,
        }),
      });
      setProvision(created);
      setMode('create');
      setFeedback('正在创建数据库…');
    } catch (err) {
      const denied =
        err instanceof ApiError &&
        (err.code === 'RDS_PERMISSION_DENIED' ||
          err.message.includes('缺少数据库创建权限') ||
          err.message.includes('阿里云云资源账户'));
      setPermissionDenied(denied);
      setError(
        denied
          ? '当前阿里云账号缺少数据库创建权限。'
          : err instanceof Error
            ? err.message
            : '创建失败',
      );
    } finally {
      setBusy(null);
    }
  }

  async function retryProvision(): Promise<void> {
    if (!provision) return;
    const ok = window.confirm(
      provision.providerResourceId
        ? '将继续上次未完成的数据库创建任务（已有云实例），不会创建新的 LaunchOS 数据库记录。'
        : '将继续上次未完成的数据库创建任务，不会创建新的 LaunchOS 数据库记录。可能在你的阿里云账号中产生费用。',
    );
    if (!ok) return;
    setBusy('retry');
    setError(null);
    try {
      const retried = await api<ProvisionStatus>(
        `/projects/${params.id}/database-provisions/${provision.id}/retry`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
      setProvision(retried);
      setRetryWatchId(retried.id);
      setFeedback(retried.currentAction || retried.phaseLabel || '等待重试任务开始…');
    } catch (err) {
      setError(err instanceof Error ? err.message : '重试失败');
      setFeedback(null);
      setRetryWatchId(null);
    } finally {
      setBusy(null);
    }
  }

  async function unlinkProvision(): Promise<void> {
    if (!provision) return;
    setBusy('unlink');
    try {
      await api(`/projects/${params.id}/database-provisions/${provision.id}/unlink`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setFeedback('已解除绑定（云数据库未删除）');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '解绑失败');
    } finally {
      setBusy(null);
    }
  }

  async function destroyProvision(): Promise<void> {
    if (!provision) return;
    const ok = window.confirm(
      '删除云数据库会永久删除其中的数据，且无法通过 LaunchOS 恢复。确定继续？',
    );
    if (!ok) return;
    setBusy('destroy');
    try {
      await api(`/projects/${params.id}/database-provisions/${provision.id}/delete`, {
        method: 'POST',
        body: JSON.stringify({ confirmDestroy: true }),
      });
      setProvision(null);
      setFeedback('云数据库已删除');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(null);
    }
  }

  async function testConnection(): Promise<boolean> {
    setBusy('test');
    setError(null);
    setTestResult(null);
    try {
      const result = await api<{
        success: boolean;
        message: string;
        latencyMs: number;
        location: string;
        errorCode?: string;
      }>(`/projects/${params.id}/database-connections/test`, {
        method: 'POST',
        body: JSON.stringify({
          engine: 'POSTGRESQL',
          host: form.host,
          port: form.port,
          databaseName: form.databaseName,
          username: form.username,
          password: form.password,
          sslMode: form.sslMode,
          testLocation: 'AUTO',
        }),
      });
      setTestResult({
        success: result.success,
        message: result.message,
        latencyMs: result.latencyMs,
        location: result.location,
      });
      return result.success;
    } catch (err) {
      const message = err instanceof Error ? err.message : '测试失败';
      setTestResult({ success: false, message });
      setError(message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function save(): Promise<void> {
    if (!payload?.canEdit) {
      setError('仅管理员可以管理数据库连接');
      return;
    }
    setBusy('save');
    setError(null);
    setFeedback(null);
    try {
      await api(`/projects/${params.id}/database-connections`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          engine: 'POSTGRESQL',
          host: form.host,
          port: form.port,
          databaseName: form.databaseName,
          username: form.username,
          password: form.password,
          sslMode: form.sslMode,
          unitIds: form.unitIds,
          testLocation: 'AUTO',
          confirmReplaceManual: true,
        }),
      });
      setFeedback('数据库连接已保存，重新上线后生效。');
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
      }>(`/projects/${params.id}/database-connections/${connection.id}/delete-impact`);
      const names = impact.affectedUnits.map((u) => u.name).join('、');
      const ok = window.confirm(
        `${impact.message}\n${names || '无'}\n\n当前运行实例不会立即停止。确认删除？`,
      );
      if (!ok) return;
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法获取删除影响');
      return;
    }
    setBusy(`del:${connection.id}`);
    try {
      await api(`/projects/${params.id}/database-connections/${connection.id}`, {
        method: 'DELETE',
      });
      setFeedback('数据库连接已删除。');
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
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">数据库</h1>
          <p className="mt-1 text-sm text-zinc-500">
            连接已有 PostgreSQL，或让 LaunchOS 在阿里云自动创建并绑定。
          </p>
          <p className="mt-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-600">
            已整合到{' '}
            <Link className="font-medium text-zinc-900 underline" href={`/projects/${params.id}/dependencies`}>
              应用依赖
            </Link>
            。本页保留给高级管理与既有测试脚本。
          </p>
        </div>

        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <p>{error}</p>
            {permissionDenied ? (
              <Link
                className="mt-2 inline-flex rounded-lg bg-zinc-900 px-3 py-1.5 text-xs text-white"
                href="/settings/cloud-accounts"
              >
                检查阿里云权限
              </Link>
            ) : null}
          </div>
        ) : null}
        {feedback && provision?.status !== '创建失败' ? (
          <p className="mt-0 text-sm text-emerald-700">{feedback}</p>
        ) : null}

        {provision ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <p className="font-medium text-zinc-900">PostgreSQL</p>
            <p className="mt-1 text-sm text-zinc-600">
              运行位置：阿里云 · 地区：{provision.region || '—'} · 状态：{provision.status}
            </p>
            <p className="mt-1 text-sm text-zinc-800">
              {provision.currentAction || provision.phaseLabel}
              {isProvisioningInFlight(provision) ? ' …' : ''}
            </p>
            {isProvisioningInFlight(provision) ? (
              <p className="mt-1 text-xs text-zinc-500">
                {formatElapsed(provision.elapsedSeconds)}
                {provision.lastActivityLabel
                  ? ` · 最近活动：${provision.lastActivityLabel}`
                  : ''}
              </p>
            ) : null}
            {provision.staleStepHint ? (
              <p className="mt-1 text-xs text-amber-700">{provision.staleStepHint}</p>
            ) : null}
            {provision.queueHint === 'QUEUE_STALLED' ||
            provision.queueHint === 'CONSUMER_OFFLINE' ? (
              <p className="mt-1 text-xs text-amber-700">
                数据库创建服务暂时不可用，任务将在恢复后继续。
              </p>
            ) : null}
            <ol className="mt-4 space-y-2">
              {provision.steps.map((step) => (
                <li key={step.key} className="flex items-center gap-2 text-sm text-zinc-700">
                  <span className="w-16 text-xs text-zinc-500">
                    {step.status === 'done'
                      ? '已完成'
                      : step.status === 'running'
                        ? '进行中'
                        : step.status === 'failed'
                          ? '失败'
                          : '等待中'}
                  </span>
                  <span>{step.label}</span>
                  {step.status === 'running' ? (
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border border-zinc-400 border-t-transparent" />
                  ) : null}
                </li>
              ))}
            </ol>
            {provision.status === '创建失败' && provision.errorMessage ? (
              <div className="mt-3 space-y-1">
                <p className="text-sm font-medium text-red-700">数据库创建失败</p>
                <p className="text-sm text-red-600">{provision.errorMessage}</p>
                {provision.providerErrorCode || provision.providerRequestId ? (
                  <p className="text-xs text-zinc-500">
                    高级详情：
                    {provision.providerErrorCode
                      ? ` ${provision.providerErrorCode}`
                      : ''}
                    {provision.providerRequestId
                      ? ` · requestId=${provision.providerRequestId}`
                      : ''}
                  </p>
                ) : null}
              </div>
            ) : null}
            {payload?.canEdit ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {provision.status === '创建失败' || provision.canRetry ? (
                  <button
                    className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-60"
                    type="button"
                    disabled={busy === 'retry'}
                    onClick={() => void retryProvision()}
                  >
                    {busy === 'retry'
                      ? '继续中…'
                      : provision.providerResourceId
                        ? '继续完成数据库配置'
                        : '重试创建'}
                  </button>
                ) : null}
                <button
                  className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                  type="button"
                  disabled={busy === 'unlink'}
                  onClick={() => void unlinkProvision()}
                >
                  解除绑定
                </button>
                <button
                  className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700"
                  type="button"
                  disabled={busy === 'destroy'}
                  onClick={() => void destroyProvision()}
                >
                  删除云数据库
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {payload.connections.map((connection) => (
          <section key={connection.id} className="rounded-2xl border border-zinc-200 bg-white p-5">
            <p className="font-medium text-zinc-900">{connection.name}</p>
            <p className="mt-1 text-sm text-zinc-600">
              PostgreSQL · {connection.status === 'CONNECTED' ? '已连接' : connection.status}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              {connection.host}:{connection.port} / {connection.databaseName}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              密码已保存 · 绑定：
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
            <h2 className="text-sm font-medium text-zinc-500">连接数据库</h2>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className={`rounded-lg px-3 py-2 text-sm ${mode === 'existing' ? 'bg-zinc-900 text-white' : 'border border-zinc-200 text-zinc-700'}`}
                onClick={() => setMode('existing')}
              >
                已有数据库
              </button>
              <button
                type="button"
                className={`rounded-lg px-3 py-2 text-sm ${mode === 'create' ? 'bg-zinc-900 text-white' : 'border border-zinc-200 text-zinc-700'}`}
                onClick={() => setMode('create')}
              >
                LaunchOS 帮我创建
              </button>
            </div>

            {mode === 'create' ? (
              <div className="mt-4 grid gap-3">
                <label className="text-sm text-zinc-700">
                  数据库类型
                  <input className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2" value="PostgreSQL" disabled />
                </label>
                <label className="text-sm text-zinc-700">
                  地区
                  <input
                    className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                    value={createForm.region}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, region: e.target.value }))}
                  />
                </label>
                <label className="text-sm text-zinc-700">
                  规格
                  <select
                    className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                    value={createForm.tier}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, tier: e.target.value }))}
                  >
                    {(options?.tiers || [
                      { tier: 'DEV', label: '开发测试' },
                      { tier: 'SMALL', label: '小型生产' },
                      { tier: 'STANDARD', label: '标准生产' },
                    ]).map((tier) => (
                      <option key={tier.tier} value={tier.tier}>
                        {tier.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-zinc-700">
                  数据库名称
                  <input
                    className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                    value={createForm.databaseName}
                    onChange={(e) =>
                      setCreateForm((prev) => ({ ...prev, databaseName: e.target.value }))
                    }
                  />
                </label>
                <div>
                  <p className="text-sm text-zinc-700">绑定到组成</p>
                  <div className="mt-2 space-y-2">
                    {payload.eligibleUnits.map((unit) => (
                      <label key={unit.id} className="flex items-center gap-2 text-sm text-zinc-700">
                        <input
                          type="checkbox"
                          checked={createForm.unitIds.includes(unit.id)}
                          onChange={(e) => {
                            setCreateForm((prev) => ({
                              ...prev,
                              unitIds: e.target.checked
                                ? [...prev.unitIds, unit.id]
                                : prev.unitIds.filter((id) => id !== unit.id),
                            }));
                          }}
                        />
                        {unit.name}
                      </label>
                    ))}
                  </div>
                </div>
                <label className="flex items-start gap-2 text-sm text-amber-900">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={createForm.confirmBilling}
                    onChange={(e) =>
                      setCreateForm((prev) => ({ ...prev, confirmBilling: e.target.checked }))
                    }
                  />
                  <span>
                    {options?.billingNotice ||
                      '将会在你的阿里云账号中创建并产生费用。实际费用以阿里云账单为准。'}
                  </span>
                </label>
                <button
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-60"
                  type="button"
                  disabled={busy === 'provision'}
                  onClick={() => void startProvision()}
                >
                  {busy === 'provision' ? '提交中…' : '创建数据库'}
                </button>
              </div>
            ) : (
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
                数据库类型
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 bg-zinc-50"
                  value="PostgreSQL"
                  disabled
                />
              </label>
              <label className="text-sm text-zinc-700">
                地址
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  value={form.host}
                  onChange={(e) => setForm((prev) => ({ ...prev, host: e.target.value }))}
                  placeholder="db.example.com"
                />
              </label>
              <label className="text-sm text-zinc-700">
                端口
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  type="number"
                  value={form.port}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, port: Number(e.target.value) || 5432 }))
                  }
                />
              </label>
              <label className="text-sm text-zinc-700">
                数据库名称
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  value={form.databaseName}
                  onChange={(e) => setForm((prev) => ({ ...prev, databaseName: e.target.value }))}
                />
              </label>
              <label className="text-sm text-zinc-700">
                用户名
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  value={form.username}
                  onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
                  autoComplete="off"
                />
              </label>
              <label className="text-sm text-zinc-700">
                密码
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                  autoComplete="new-password"
                />
              </label>
              <label className="text-sm text-zinc-700">
                SSL
                <select
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  value={form.sslMode}
                  onChange={(e) => setForm((prev) => ({ ...prev, sslMode: e.target.value }))}
                >
                  <option value="AUTO">自动</option>
                  <option value="REQUIRE">需要 SSL</option>
                  <option value="DISABLE">不使用 SSL</option>
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
            )}

            {mode === 'existing' && testResult ? (
              <p
                className={`mt-3 text-sm ${testResult.success ? 'text-emerald-700' : 'text-red-600'}`}
              >
                {testResult.message}
                {testResult.latencyMs != null ? ` · ${testResult.latencyMs}ms` : ''}
              </p>
            ) : null}

            {mode === 'existing' ? (
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
                {busy === 'save' ? '保存中…' : '保存数据库连接'}
              </button>
            </div>
            ) : null}
          </section>
        ) : null}

        {payload.eligibleUnits.length === 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5 text-sm text-zinc-600">
            当前应用没有需要 DATABASE_URL 的组成。
          </section>
        ) : null}
      </div>
    </main>
  );
}
