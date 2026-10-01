'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';

type ConfigRequirement = {
  key: string;
  label: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  managedByLaunchOS: boolean;
  configured: boolean;
  effectiveConfigured?: boolean;
  missing: boolean;
  applyStatus?: 'missing' | 'pending' | 'applied' | 'managed';
  maskedValue: string | null;
  value: string | null;
  defaultValue: string | null;
  source: string;
  confidence: string;
  resolvedSource?: string;
  resolvedSourceLabel?: string;
  valueOrigin?: string | null;
  valueOriginLabel?: string | null;
  configType?: 'USER_PROVIDED' | 'GENERATABLE_SECRET';
  generatable?: boolean;
  hasUnitOverride?: boolean;
  hasProjectValue?: boolean;
  needsRedeploy?: boolean;
  overrideHint?: string | null;
  rotationStatus?: string;
  rotationStatusLabel?: string;
  rotationIntervalDays?: number | null;
  suggestedRotationIntervalDays?: number | null;
  lastUpdatedAt?: string | null;
  lastUpdatedByName?: string | null;
  lastUpdatedAgo?: string | null;
  lastRotatedAgo?: string | null;
  providerLabel?: string | null;
  managedByDatabaseConnection?: boolean;
  managedByRedisConnection?: boolean;
};

type ConfigPayload = {
  unit: { id: string; name: string; type: string; rootPath: string };
  summary: {
    total: number;
    completed: number;
    missingRequired: number;
    pendingApply?: boolean;
  };
  canEdit: boolean;
  canEditSecrets: boolean;
  canViewAudit?: boolean;
  secretFilesWarning: string | null;
  applyHint?: string | null;
  requirements: ConfigRequirement[];
};

export default function UnitRuntimeConfigPage() {
  const router = useRouter();
  const params = useParams<{ id: string; unitId: string }>();
  const [payload, setPayload] = useState<ConfigPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<ConfigPayload>(
      `/projects/${params.id}/units/${params.unitId}/config-requirements`,
    );
    setPayload(data);
    const next: Record<string, string> = {};
    for (const item of data.requirements) {
      if (!item.sensitive && item.value) {
        next[item.key] = item.value;
      }
    }
    setDrafts(next);
  }, [params.id, params.unitId]);

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

  const groups = useMemo(() => {
    const items = payload?.requirements ?? [];
    return {
      needed: items.filter((item) => !item.managedByLaunchOS && item.missing),
      configured: items.filter(
        (item) => !item.managedByLaunchOS && item.configured && !item.missing,
      ),
      managed: items.filter((item) => item.managedByLaunchOS),
      optional: items.filter(
        (item) => !item.managedByLaunchOS && !item.required && !item.configured && !item.missing,
      ),
    };
  }, [payload]);

  async function save(item: ConfigRequirement): Promise<void> {
    const value = drafts[item.key]?.trim() ?? '';
    if (!value) {
      setError('请填写配置值');
      return;
    }
    if (item.sensitive && !payload?.canEditSecrets) {
      setError('仅管理员可以修改敏感配置');
      return;
    }
    setBusyKey(item.key);
    setError(null);
    setFeedback(null);
    try {
      await api(`/projects/${params.id}/units/${params.unitId}/config/${encodeURIComponent(item.key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      setFeedback(
        item.sensitive
          ? `${item.label || item.key} 已更新。配置已更新，需要重新上线后生效。`
          : `${item.label || item.key} 已配置。配置已更新，需要重新上线后生效。`,
      );
      setDrafts((prev) => ({ ...prev, [item.key]: item.sensitive ? '' : value }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusyKey(null);
    }
  }

  async function generate(item: ConfigRequirement): Promise<void> {
    if (!item.generatable) {
      setError('该项不能自动生成');
      return;
    }
    if (!payload?.canEditSecrets) {
      setError('仅管理员可以修改敏感配置');
      return;
    }
    setBusyKey(`gen:${item.key}`);
    setError(null);
    setFeedback(null);
    try {
      await api(
        `/projects/${params.id}/units/${params.unitId}/config/${encodeURIComponent(item.key)}/generate`,
        { method: 'POST' },
      );
      setFeedback(`${item.label || item.key} 已配置（LaunchOS 自动生成）。配置已更新，需要重新上线后生效。`);
      setDrafts((prev) => ({ ...prev, [item.key]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
    } finally {
      setBusyKey(null);
    }
  }

  async function restoreShared(item: ConfigRequirement): Promise<void> {
    if (item.sensitive && !payload?.canEditSecrets) {
      setError('仅管理员可以修改敏感配置');
      return;
    }
    setBusyKey(`restore:${item.key}`);
    setError(null);
    try {
      await api(
        `/projects/${params.id}/units/${params.unitId}/config/${encodeURIComponent(item.key)}/restore-shared`,
        { method: 'POST' },
      );
      setFeedback('已恢复使用应用共享配置，重新上线后生效。');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复失败');
    } finally {
      setBusyKey(null);
    }
  }

  async function promoteToShared(item: ConfigRequirement): Promise<void> {
    if (item.sensitive && !payload?.canEditSecrets) {
      setError('仅管理员可以修改敏感配置');
      return;
    }
    if (!window.confirm(`确认将 ${item.label} 设为应用共享配置？此操作不会显示或复制 Secret 内容。`)) {
      return;
    }
    setBusyKey(`promote:${item.key}`);
    setError(null);
    try {
      await api(
        `/projects/${params.id}/config/${encodeURIComponent(item.key)}/promote-from-unit`,
        {
          method: 'POST',
          body: JSON.stringify({ unitId: params.unitId }),
        },
      );
      setFeedback('已设为应用共享配置。');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyKey(null);
    }
  }

  async function remove(item: ConfigRequirement): Promise<void> {
    if (item.sensitive && !payload?.canEditSecrets) {
      setError('仅管理员可以修改敏感配置');
      return;
    }
    try {
      const impact = await api<{
        message: string;
        affectedUnits: Array<{ name: string }>;
      }>(`/projects/${params.id}/units/${params.unitId}/config/${encodeURIComponent(item.key)}/delete-impact`);
      const names = impact.affectedUnits.map((unit) => unit.name).join('、');
      const confirmText = names
        ? `${impact.message}\n${names}\n\n当前运行实例不会立即停止。确认删除？`
        : '确认删除此配置？当前运行实例不会立即停止。';
      if (!window.confirm(confirmText)) {
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法获取删除影响');
      return;
    }
    setBusyKey(`del:${item.key}`);
    setError(null);
    try {
      await api(`/projects/${params.id}/units/${params.unitId}/config/${encodeURIComponent(item.key)}`, {
        method: 'DELETE',
      });
      setFeedback('配置已删除。当前应用仍在使用上次上线时的配置。');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusyKey(null);
    }
  }

  async function updateRotationPolicy(item: ConfigRequirement, days: number | null): Promise<void> {
    if (item.sensitive && !payload?.canEditSecrets) {
      setError('仅管理员可以修改敏感配置');
      return;
    }
    setBusyKey(`rotation:${item.key}`);
    setError(null);
    try {
      await api(
        `/projects/${params.id}/units/${params.unitId}/config/${encodeURIComponent(item.key)}/rotation-policy`,
        {
          method: 'PATCH',
          body: JSON.stringify({ rotationIntervalDays: days }),
        },
      );
      setFeedback(days ? `已设置 ${days} 天轮换提醒。` : '已关闭轮换提醒。');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '设置失败');
    } finally {
      setBusyKey(null);
    }
  }

  async function rescan(): Promise<void> {
    setBusyKey('rescan');
    setError(null);
    try {
      const data = await api<ConfigPayload>(
        `/projects/${params.id}/units/${params.unitId}/config/rescan`,
        { method: 'POST' },
      );
      setPayload(data);
      setFeedback(data.secretFilesWarning || '已重新分析运行配置');
    } catch (err) {
      setError(err instanceof Error ? err.message : '重新分析失败');
    } finally {
      setBusyKey(null);
    }
  }

  if (!payload) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        {error ?? '加载中…'}
      </main>
    );
  }

  const { canEdit, canEditSecrets } = payload;

  function renderItem(item: ConfigRequirement) {
    const canWrite = item.sensitive ? canEditSecrets : canEdit;
    return (
      <li key={item.key} className="rounded-xl border border-zinc-100 px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-medium text-zinc-900">{item.label}</p>
            <p className="mt-1 text-xs text-zinc-500">环境变量名称：{item.key}</p>
            <p className="mt-2 text-sm text-zinc-600">{item.description}</p>
            <p className="mt-2 text-xs text-zinc-500">
              {item.required ? '必填' : '可选'}
              {item.sensitive ? ' · 敏感' : ''}
              {item.missing ? ' · 未配置' : item.configured ? ' · 已配置' : ''}
              {item.valueOriginLabel ? ` · 来源：${item.valueOriginLabel}` : item.resolvedSourceLabel ? ` · 来源：${item.resolvedSourceLabel}` : ''}
              {item.providerLabel ? ` · ${item.providerLabel}` : ''}
              {item.managedByDatabaseConnection ? ' · 数据库连接已配置' : ''}
              {item.managedByRedisConnection ? ' · Redis 连接已配置' : ''}
              {item.rotationStatusLabel ? ` · ${item.rotationStatusLabel}` : ''}
              {item.maskedValue ? ` · ${item.maskedValue}` : ''}
            </p>
            {item.lastUpdatedByName || item.lastUpdatedAgo ? (
              <p className="mt-1 text-xs text-zinc-500">
                最近更新：{item.lastUpdatedAgo ?? '—'}
                {item.lastUpdatedByName ? ` · 由 ${item.lastUpdatedByName} 修改` : ''}
              </p>
            ) : null}
            {item.sensitive && item.rotationIntervalDays ? (
              <p className="mt-1 text-xs text-zinc-500">{item.rotationIntervalDays} 天轮换提醒</p>
            ) : null}
            {item.sensitive &&
            item.suggestedRotationIntervalDays &&
            !item.rotationIntervalDays ? (
              <p className="mt-1 text-xs text-zinc-400">
                建议 {item.suggestedRotationIntervalDays} 天轮换提醒（可选）
              </p>
            ) : null}
            {item.overrideHint ? (
              <p className="mt-1 text-xs text-amber-700">{item.overrideHint}</p>
            ) : null}
          </div>
          {item.managedByLaunchOS ? (
            <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600">
              LaunchOS 自动管理
            </span>
          ) : null}
        </div>
        {!item.managedByLaunchOS && canWrite ? (
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                className="flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                type={item.sensitive && !reveal[item.key] ? 'password' : 'text'}
                placeholder={
                  item.sensitive
                    ? item.configured
                      ? '输入新值以替换（不会显示当前值）'
                      : '请输入，或使用自动生成'
                    : '请输入'
                }
                value={drafts[item.key] ?? ''}
                onChange={(event) =>
                  setDrafts((prev) => ({ ...prev, [item.key]: event.target.value }))
                }
                autoComplete="off"
              />
              {item.sensitive ? (
                <button
                  className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700"
                  type="button"
                  onClick={() =>
                    setReveal((prev) => ({ ...prev, [item.key]: !prev[item.key] }))
                  }
                >
                  {reveal[item.key] ? '隐藏' : '显示'}
                </button>
              ) : null}
              <button
                className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-60"
                type="button"
                disabled={busyKey === item.key}
                onClick={() => void save(item)}
              >
                {busyKey === item.key ? '保存中…' : item.configured && item.sensitive ? '替换' : '保存'}
              </button>
              {item.generatable && canEditSecrets ? (
                <button
                  className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 disabled:opacity-60"
                  type="button"
                  disabled={busyKey === `gen:${item.key}`}
                  onClick={() => void generate(item)}
                >
                  {busyKey === `gen:${item.key}` ? '生成中…' : '自动生成安全值'}
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
            {item.hasUnitOverride && item.hasProjectValue ? (
              <button
                className="rounded-lg border border-sky-200 px-3 py-2 text-sm text-sky-800 disabled:opacity-60"
                type="button"
                disabled={busyKey === `restore:${item.key}`}
                onClick={() => void restoreShared(item)}
              >
                恢复使用共享配置
              </button>
            ) : null}
            {item.hasUnitOverride && item.configured && !item.hasProjectValue ? (
              <button
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 disabled:opacity-60"
                type="button"
                disabled={busyKey === `promote:${item.key}`}
                onClick={() => void promoteToShared(item)}
              >
                设为应用共享配置
              </button>
            ) : null}
            {item.configured && !item.defaultValue && item.hasUnitOverride ? (
              <button
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 disabled:opacity-60"
                type="button"
                disabled={busyKey === `del:${item.key}`}
                onClick={() => void remove(item)}
              >
                删除本组成设置
              </button>
            ) : null}
            </div>
          </div>
        ) : null}
        {item.sensitive && canEditSecrets && item.configured ? (
          <div className="mt-2">
            <label className="text-xs text-zinc-500">轮换提醒</label>
            <select
              className="mt-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
              value={item.rotationIntervalDays ?? ''}
              disabled={busyKey === `rotation:${item.key}`}
              onChange={(event) => {
                const value = event.target.value;
                void updateRotationPolicy(item, value ? Number(value) : null);
              }}
            >
              <option value="">不提醒</option>
              <option value="30">30 天</option>
              <option value="60">60 天</option>
              <option value="90">90 天</option>
              <option value="180">180 天</option>
            </select>
          </div>
        ) : null}
      </li>
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
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">运行配置</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {payload.summary.missingRequired > 0
              ? '你的应用上线前还需要以下配置。'
              : `${payload.unit.name} · 这些配置用于让应用在上线后正常运行。`}
          </p>
          <p className="mt-2 text-sm text-zinc-700">
            {payload.summary.missingRequired > 0
              ? `你的应用还需要 ${payload.summary.missingRequired} 项运行配置。`
              : `需要配置 ${payload.summary.total} 项 · 已完成 ${payload.summary.completed} 项`}
          </p>
        </div>

        {payload.summary.missingRequired === 0 ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            <p>运行配置已齐全。修改后的配置需要重新上线后才会在当前运行环境生效。</p>
            <Link
              className="mt-3 inline-flex rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white"
              href={`/projects/${params.id}`}
            >
              返回应用并重新上线
            </Link>
          </div>
        ) : null}

        {payload.summary.pendingApply || payload.applyHint ? (
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            {payload.applyHint || '配置已更新，需要重新上线后生效。'}
          </div>
        ) : null}

        {payload.summary.missingRequired > 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            你的应用上线前还需要以下配置。
          </div>
        ) : null}

        {payload.secretFilesWarning ? (
          <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-700">
            {payload.secretFilesWarning}
          </div>
        ) : null}

        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {feedback ? <p className="text-sm text-emerald-700">{feedback}</p> : null}

        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 disabled:opacity-60"
            type="button"
            disabled={busyKey === 'rescan'}
            onClick={() => void rescan()}
          >
            {busyKey === 'rescan' ? '分析中…' : '重新分析'}
          </button>
          {payload.canViewAudit ? (
            <Link
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700"
              href={`/projects/${params.id}/config/audit`}
            >
              查看审计
            </Link>
          ) : null}
        </div>

        {groups.needed.length > 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <h2 className="text-sm font-medium text-zinc-500">需要配置</h2>
            <ul className="mt-4 space-y-3">{groups.needed.map(renderItem)}</ul>
          </section>
        ) : null}

        {groups.configured.length > 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <h2 className="text-sm font-medium text-zinc-500">已配置</h2>
            <ul className="mt-4 space-y-3">{groups.configured.map(renderItem)}</ul>
          </section>
        ) : null}

        {groups.optional.length > 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <h2 className="text-sm font-medium text-zinc-500">可选配置</h2>
            <ul className="mt-4 space-y-3">{groups.optional.map(renderItem)}</ul>
          </section>
        ) : null}

        {groups.managed.length > 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <h2 className="text-sm font-medium text-zinc-500">LaunchOS 自动管理</h2>
            <ul className="mt-4 space-y-3">{groups.managed.map(renderItem)}</ul>
          </section>
        ) : null}

        {payload.requirements.length === 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5 text-sm text-zinc-600">
            暂未识别到运行配置。可点击「重新分析」。
          </section>
        ) : null}
      </div>
    </main>
  );
}
