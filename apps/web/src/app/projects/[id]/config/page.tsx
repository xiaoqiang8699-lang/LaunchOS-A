'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ControlCenter } from '@/components/control-center';
import { ProjectTabs } from '@/components/control-center/project-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { PageHeader, Card } from '@/components/ui/section';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';

type SharedConfigItem = {
  key: string;
  label: string;
  description: string;
  sensitive: boolean;
  configured: boolean;
  maskedValue: string | null;
  usingUnits: Array<{ id: string; name: string }>;
  unitApplyStatuses?: Array<{
    id: string;
    name: string;
    applyStatus: 'applied' | 'pending' | 'missing';
    applyStatusLabel: string;
  }>;
  usageCategory: 'multiple' | 'single' | 'unused';
  rotationStatusLabel?: string;
  rotationIntervalDays?: number | null;
  lastUpdatedByName?: string | null;
  lastUpdatedAgo?: string | null;
  suggestedRotationIntervalDays?: number | null;
};

type ProjectConfigPayload = {
  summary: {
    total: number;
    unitsUsingCount: number;
    pendingRedeployCount: number;
  };
  canEdit: boolean;
  canEditSecrets: boolean;
  canViewAudit?: boolean;
  configs: SharedConfigItem[];
  pendingUnits: Array<{ id: string; name: string }>;
};

const USAGE_LABELS: Record<SharedConfigItem['usageCategory'], string> = {
  multiple: '被多个组成使用',
  single: '仅一个组成使用',
  unused: '暂未使用',
};

export default function ProjectSharedConfigPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [payload, setPayload] = useState<ProjectConfigPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const load = useCallback(async () => {
    const data = await api<ProjectConfigPayload>(`/projects/${params.id}/config`);
    setPayload(data);
  }, [params.id]);

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
    const items = payload?.configs ?? [];
    return {
      needed: items.filter((item) => !item.configured),
      configured: items.filter(
        (item) => item.configured && item.usageCategory !== 'unused',
      ),
      system: items.filter(
        (item) => item.configured && item.usageCategory === 'unused',
      ),
    };
  }, [payload]);

  async function createShared(): Promise<void> {
    const key = newKey.trim();
    const value = newValue.trim();
    if (!key || !value) {
      setError('请填写配置名称和值');
      return;
    }
    setBusyKey('create');
    setError(null);
    setFeedback(null);
    try {
      await api(`/projects/${params.id}/config/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      setNewKey('');
      setNewValue('');
      setFeedback('共享配置已创建。');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusyKey(null);
    }
  }

  async function updateRotationPolicy(item: SharedConfigItem, days: number | null): Promise<void> {
    if (item.sensitive && !payload?.canEditSecrets) {
      setError('仅管理员可以修改敏感配置');
      return;
    }
    setBusyKey(`rotation:${item.key}`);
    setError(null);
    try {
      await api(`/projects/${params.id}/config/${encodeURIComponent(item.key)}/rotation-policy`, {
        method: 'PATCH',
        body: JSON.stringify({ rotationIntervalDays: days }),
      });
      setFeedback(days ? `已设置 ${days} 天轮换提醒。` : '已关闭轮换提醒。');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '设置失败');
    } finally {
      setBusyKey(null);
    }
  }

  async function removeItem(item: SharedConfigItem): Promise<void> {
    if (item.sensitive && !payload?.canEditSecrets) {
      setError('仅管理员可以修改敏感配置');
      return;
    }
    try {
      const impact = await api<{
        message: string;
        affectedUnits: Array<{ name: string }>;
      }>(`/projects/${params.id}/config/${encodeURIComponent(item.key)}/delete-impact`);
      const names = impact.affectedUnits.map((unit) => unit.name).join('、');
      const confirmText = names
        ? `${impact.message}\n${names}\n\n当前运行实例不会立即停止。确认删除？`
        : '确认删除此共享配置？当前运行实例不会立即停止。';
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
      await api(`/projects/${params.id}/config/${encodeURIComponent(item.key)}`, {
        method: 'DELETE',
      });
      setFeedback('共享配置已删除。');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusyKey(null);
    }
  }

  function renderItem(item: SharedConfigItem) {
    return (
      <li
        key={item.key}
        className="rounded-lg border border-[var(--los-border)] px-3.5 py-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium text-[var(--los-text)]">{item.label}</p>
            <p className="mt-0.5 text-xs text-[var(--los-muted)]">环境变量：{item.key}</p>
            {item.description ? (
              <p className="mt-1.5 text-sm text-[var(--los-secondary)]">{item.description}</p>
            ) : null}
            <p className="mt-1.5 text-xs text-[var(--los-secondary)]">
              {USAGE_LABELS[item.usageCategory]}
              {item.maskedValue ? ` · ${item.maskedValue}` : ''}
              {!item.configured ? ' · 待补充' : ''}
            </p>
            {item.rotationStatusLabel ? (
              <p className="mt-1 text-xs text-[var(--los-secondary)]">{item.rotationStatusLabel}</p>
            ) : null}
            {item.lastUpdatedByName || item.lastUpdatedAgo ? (
              <p className="mt-1 text-xs text-[var(--los-muted)]">
                最近更新：{item.lastUpdatedAgo ?? '—'}
                {item.lastUpdatedByName ? ` · 由 ${item.lastUpdatedByName} 修改` : ''}
              </p>
            ) : null}
            {item.unitApplyStatuses && item.unitApplyStatuses.length > 0 ? (
              <div className="mt-1.5 space-y-0.5">
                {item.unitApplyStatuses.map((unit) => (
                  <p key={unit.id} className="text-xs text-[var(--los-secondary)]">
                    {unit.name}：{unit.applyStatusLabel}
                  </p>
                ))}
              </div>
            ) : item.usingUnits.length > 0 ? (
              <p className="mt-1.5 text-xs text-[var(--los-secondary)]">
                使用组成：{item.usingUnits.map((unit) => unit.name).join('、')}
              </p>
            ) : (
              <p className="mt-1.5 text-xs text-[var(--los-warning)]">当前没有组成使用此配置</p>
            )}
          </div>
        </div>
        {item.sensitive && payload?.canEditSecrets ? (
          <div className="mt-2">
            <label className="text-xs text-[var(--los-secondary)]">轮换提醒</label>
            <select
              className="mt-1 rounded-lg border border-[var(--los-border)] px-2 py-1.5 text-sm"
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
        {payload?.canEdit ? (
          <div className="mt-2">
            <button
              className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm text-[var(--los-secondary)] disabled:opacity-60"
              type="button"
              disabled={busyKey === `del:${item.key}`}
              onClick={() => void removeItem(item)}
            >
              删除
            </button>
          </div>
        ) : null}
      </li>
    );
  }

  if (!payload) {
    return (
      <ControlCenter>
        <ProjectTabs projectId={params.id} />
        {error ? (
          <InlineAlert tone="error" title={error} />
        ) : (
          <div className="space-y-3">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-28" />
          </div>
        )}
      </ControlCenter>
    );
  }

  return (
    <ControlCenter>
      <nav className="mb-4 text-sm text-[var(--los-secondary)]">
        <Link className="hover:text-[var(--los-text)]" href="/projects">
          我的应用
        </Link>
        <span className="mx-2">›</span>
        <Link className="hover:text-[var(--los-text)]" href={`/projects/${params.id}`}>
          应用
        </Link>
        <span className="mx-2">›</span>
        <span className="text-[var(--los-text)]">配置</span>
      </nav>

      <ProjectTabs projectId={params.id} />

      <PageHeader
        title="运行配置"
        description="共享配置可被多个组成复用；只有实际需要的组成才会使用。"
        action={
          payload.canViewAudit ? (
            <Link
              className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
              href={`/projects/${params.id}/config/audit`}
            >
              配置审计
            </Link>
          ) : null
        }
      />

      <p className="mb-4 text-sm text-[var(--los-secondary)]">
        {payload.summary.total} 项共享配置 · {payload.summary.unitsUsingCount} 个组成正在使用
        {payload.summary.pendingRedeployCount > 0
          ? ` · ${payload.summary.pendingRedeployCount} 个组成等待重新上线`
          : ''}
      </p>

      {payload.pendingUnits.length > 0 ? (
        <InlineAlert
          className="mb-4"
          tone="info"
          title="共享配置已更新，以下组成需要重新上线后生效"
          description={payload.pendingUnits.map((u) => u.name).join('、')}
        />
      ) : null}

      {error ? <InlineAlert className="mb-3" tone="error" title={error} /> : null}
      {feedback ? <InlineAlert className="mb-3" tone="success" title={feedback} /> : null}

      {payload.canEdit ? (
        <Card className="mb-5 p-4">
          <h2 className="text-sm font-medium text-[var(--los-secondary)]">新增共享配置</h2>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              className="flex-1 rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
              placeholder="环境变量名称，如 SENTRY_DSN"
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
            />
            <input
              className="flex-1 rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
              placeholder="配置值"
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              autoComplete="off"
            />
            <button
              className="rounded-lg bg-[var(--los-action)] px-3 py-2 text-sm text-white disabled:opacity-60"
              type="button"
              disabled={busyKey === 'create'}
              onClick={() => void createShared()}
            >
              {busyKey === 'create' ? '保存中…' : '添加'}
            </button>
          </div>
        </Card>
      ) : null}

      <div className="space-y-5">
        {groups.needed.length > 0 ? (
          <section>
            <h2 className="mb-2 text-sm font-medium text-[var(--los-warning)]">需要补充</h2>
            <ul className="space-y-2">{groups.needed.map(renderItem)}</ul>
          </section>
        ) : null}

        {groups.configured.length > 0 ? (
          <section>
            <h2 className="mb-2 text-sm font-medium text-[var(--los-secondary)]">已配置</h2>
            <ul className="space-y-2">{groups.configured.map(renderItem)}</ul>
          </section>
        ) : null}

        {groups.system.length > 0 ? (
          <section>
            <h2 className="mb-2 text-sm font-medium text-[var(--los-muted)]">系统管理</h2>
            <p className="mb-2 text-xs text-[var(--los-muted)]">
              已保存但当前没有组成使用的共享项，可按需清理。
            </p>
            <ul className="space-y-2">{groups.system.map(renderItem)}</ul>
          </section>
        ) : null}

        {payload.configs.length === 0 ? (
          <Card className="p-5 text-sm text-[var(--los-secondary)]">
            还没有共享配置。可在各组成的运行配置页将已有项「设为应用共享配置」，或在此手工添加。
          </Card>
        ) : null}
      </div>
    </ControlCenter>
  );
}
