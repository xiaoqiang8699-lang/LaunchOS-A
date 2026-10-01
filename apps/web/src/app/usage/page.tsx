'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { InlineAlert, Skeleton, UsageBar } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { SecondaryLink } from '@/components/ui/button';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { isBetaEntitlementSource } from '@/lib/plan-prices';

type UsageView = {
  planName?: string;
  plan?: string;
  source?: string;
  override?: { reason?: string | null } | null;
  ui?: Record<string, string>;
  usage?: {
    projects: number;
    monthlyDeployments: number;
    members: number;
    runningApps: number;
  };
  entitlements?: {
    maxProjects: number | null;
    maxMonthlyDeployments: number | null;
    maxWorkspaceMembers: number | null;
    maxRunningApps: number | null;
    maxRetainedVersions: number | null;
    logRetentionDays: number | null;
    customDomainEnabled: boolean;
  };
  warnings?: Array<{ message: string }>;
};

function ratio(used: number | null | undefined, limit: number | null | undefined) {
  if (used == null || limit == null || limit <= 0) return null;
  return used / limit;
}

export default function UsagePage() {
  const router = useRouter();
  const [view, setView] = useState<UsageView | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void api<UsageView>('/account/usage')
      .then(setView)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'));
  }, [router]);

  const beta = isBetaEntitlementSource(view?.source, view?.override?.reason);
  const deployRatio = ratio(view?.usage?.monthlyDeployments, view?.entitlements?.maxMonthlyDeployments);
  const projectRatio = ratio(view?.usage?.projects, view?.entitlements?.maxProjects);
  const memberRatio = ratio(view?.usage?.members, view?.entitlements?.maxWorkspaceMembers);
  const runningRatio = ratio(view?.usage?.runningApps, view?.entitlements?.maxRunningApps);
  const anyNear = [deployRatio, projectRatio, memberRatio, runningRatio].some(
    (v) => v != null && v >= 0.8 && v < 1,
  );
  const anyOver = [deployRatio, projectRatio, memberRatio, runningRatio].some(
    (v) => v != null && v >= 1,
  );

  return (
    <ControlCenter>
      <PageHeader
        title="用量"
        description="查看当前套餐的使用情况"
        action={<SecondaryLink href="/plan">查看套餐</SecondaryLink>}
      />

      {error ? <InlineAlert tone="error" title="加载失败" description={error} /> : null}
      {!view ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs text-[var(--los-secondary)]">当前套餐</p>
              <p className="mt-1 text-xl font-semibold">{view.planName || view.plan || 'Free'}</p>
              {beta ? (
                <p className="mt-1 text-xs text-[var(--los-muted)]">Beta 测试额度</p>
              ) : null}
            </Card>
            <Card className="p-4">
              <p className="text-xs text-[var(--los-secondary)]">本月上线</p>
              <p className="mt-1 text-xl font-semibold">
                {view.usage?.monthlyDeployments ?? '—'} /{' '}
                {view.entitlements?.maxMonthlyDeployments ?? '不限'}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-[var(--los-secondary)]">应用</p>
              <p className="mt-1 text-xl font-semibold">
                {view.usage?.projects ?? '—'} / {view.entitlements?.maxProjects ?? '不限'}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-[var(--los-secondary)]">成员</p>
              <p className="mt-1 text-xl font-semibold">
                {view.usage?.members ?? '—'} / {view.entitlements?.maxWorkspaceMembers ?? '不限'}
              </p>
            </Card>
          </div>

          {anyOver ? (
            <InlineAlert
              className="mb-4"
              tone="error"
              title="已有额度达到上限"
              description="部分配额已用完，升级套餐后可继续扩展。"
              actionLabel="查看套餐"
              actionHref="/plan"
            />
          ) : anyNear ? (
            <InlineAlert
              className="mb-4"
              tone="warning"
              title="部分额度接近上限"
              description="使用量已超过 80%，建议提前查看套餐。"
              actionLabel="查看套餐"
              actionHref="/plan"
            />
          ) : null}

          {view.warnings?.length ? (
            <div className="mb-4 space-y-2">
              {view.warnings.map((w) => (
                <InlineAlert
                  key={w.message}
                  tone="warning"
                  title={w.message}
                  actionLabel="查看套餐"
                  actionHref="/plan"
                />
              ))}
            </div>
          ) : null}

          <Section title="使用详情">
            <div className="grid gap-3 sm:grid-cols-2">
              <UsageBar
                label="本月上线"
                used={view.usage?.monthlyDeployments ?? null}
                limit={view.entitlements?.maxMonthlyDeployments ?? null}
              />
              <UsageBar
                label="应用"
                used={view.usage?.projects ?? null}
                limit={view.entitlements?.maxProjects ?? null}
              />
              <UsageBar
                label="运行应用"
                used={view.usage?.runningApps ?? null}
                limit={view.entitlements?.maxRunningApps ?? null}
              />
              <UsageBar
                label="成员"
                used={view.usage?.members ?? null}
                limit={view.entitlements?.maxWorkspaceMembers ?? null}
              />
            </div>
            <Card className="mt-3 grid gap-2 p-4 text-sm text-[var(--los-secondary)] sm:grid-cols-3">
              <p>历史版本：{view.entitlements?.maxRetainedVersions ?? '不限'}</p>
              <p>日志保留：{view.entitlements?.logRetentionDays ?? '不限'} 天</p>
              <p>自定义域名：{view.entitlements?.customDomainEnabled ? '可用' : '不可用'}</p>
            </Card>
          </Section>
        </>
      )}
    </ControlCenter>
  );
}
