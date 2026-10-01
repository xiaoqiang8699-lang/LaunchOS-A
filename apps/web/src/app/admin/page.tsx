'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';

type Overview = {
  users: number;
  usersToday?: number;
  workspaces: number;
  workspacesToday?: number;
  applications: number;
  liveApplications: number;
  unhealthyApplications: number;
  deploymentsToday?: number;
  deploymentsTodaySuccess?: number;
  deploymentsTodayFailed?: number;
  deploymentsRunning?: number;
  deploymentsQueued?: number;
  deploymentSuccessRateToday?: number | null;
  activePaidSubscriptions: number;
  freeWorkspaces: number;
  proWorkspaces: number;
  teamWorkspaces: number;
  enterpriseWorkspaces: number;
  upgradeRequestsPending: number;
  alphaSessions: number;
  alphaCompleted?: number;
  alphaFailed?: number;
  workerOnline?: boolean | null;
  queueWaiting?: number | null;
  queueFailed?: number | null;
  capacityWarnings?: number;
};

export default function AdminOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Overview>('/admin/overview')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  if (error) return <InlineAlert tone="error" title={error} />;
  if (!data) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  const alerts: Array<{ tone: 'error' | 'warning' | 'info'; title: string; href?: string }> = [];
  if (data.workerOnline === false) {
    alerts.push({ tone: 'error', title: 'Worker 离线', href: '/admin/system' });
  }
  if ((data.queueFailed ?? 0) > 0) {
    alerts.push({
      tone: 'warning',
      title: `部署队列失败 ${data.queueFailed}`,
      href: '/admin/system',
    });
  }
  if ((data.capacityWarnings ?? 0) > 0) {
    alerts.push({
      tone: 'warning',
      title: `容量告警 ${data.capacityWarnings}`,
      href: '/admin/resources',
    });
  }
  if (data.unhealthyApplications > 0) {
    alerts.push({
      tone: 'warning',
      title: `公网异常应用 ${data.unhealthyApplications}`,
      href: '/admin/apps',
    });
  }
  if ((data.alphaFailed ?? 0) > 0) {
    alerts.push({
      tone: 'error',
      title: `Beta/Alpha 失败 Session ${data.alphaFailed}`,
      href: '/admin/beta',
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader title="平台总览" description="整个平台现在怎么样？" />

      {alerts.length > 0 ? (
        <Section title="需要处理">
          <div className="space-y-2">
            {alerts.map((item) => (
              <InlineAlert
                key={item.title}
                tone={item.tone}
                title={item.title}
                actionLabel={item.href ? '查看' : undefined}
                actionHref={item.href}
              />
            ))}
          </div>
        </Section>
      ) : (
        <InlineAlert tone="success" title="当前没有需要优先处理的平台告警" />
      )}

      <Section title="用户与 Workspace">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="总用户" value={data.users} hint={data.usersToday != null ? `今日 +${data.usersToday}` : undefined} />
          <Metric label="Workspace" value={data.workspaces} hint={data.workspacesToday != null ? `今日 +${data.workspacesToday}` : undefined} />
          <Metric label="总应用" value={data.applications} />
          <Metric label="运行正常" value={data.liveApplications} />
        </div>
      </Section>

      <Section title="部署">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="今日部署" value={data.deploymentsToday ?? 0} />
          <Metric label="今日成功" value={data.deploymentsTodaySuccess ?? 0} />
          <Metric label="今日失败" value={data.deploymentsTodayFailed ?? 0} />
          <Metric
            label="成功率"
            value={
              data.deploymentSuccessRateToday == null ? '—' : `${data.deploymentSuccessRateToday}%`
            }
          />
          <Metric
            label="进行中 / 排队"
            value={`${data.deploymentsRunning ?? 0} / ${data.deploymentsQueued ?? 0}`}
          />
        </div>
      </Section>

      <Section title="平台健康">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Worker"
            value={data.workerOnline == null ? '—' : data.workerOnline ? 'ONLINE' : 'OFFLINE'}
          />
          <Metric label="Queue waiting" value={data.queueWaiting ?? '—'} />
          <Metric label="Queue failed" value={data.queueFailed ?? '—'} />
          <Metric label="需要处理应用" value={data.unhealthyApplications} href="/admin/apps" />
        </div>
      </Section>

      <Section title="商业与 Beta">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="付费订阅" value={data.activePaidSubscriptions} href="/admin/commercial" />
          <Metric
            label="套餐分布"
            value={`F${data.freeWorkspaces}/P${data.proWorkspaces}/T${data.teamWorkspaces}/E${data.enterpriseWorkspaces}`}
          />
          <Metric label="升级申请" value={data.upgradeRequestsPending} href="/admin/upgrade-requests" />
          <Metric
            label="Beta Sessions"
            value={`${data.alphaCompleted ?? 0} / ${data.alphaSessions}`}
            href="/admin/beta"
          />
        </div>
      </Section>
    </div>
  );
}

function Metric(props: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
}) {
  const body = (
    <Card className="p-4">
      <p className="text-xs text-zinc-500">{props.label}</p>
      <p className="mt-1 text-2xl font-semibold text-zinc-900">{props.value}</p>
      {props.hint ? <p className="mt-1 text-xs text-zinc-500">{props.hint}</p> : null}
    </Card>
  );
  if (!props.href) return body;
  return (
    <Link href={props.href} className="block transition hover:opacity-90">
      {body}
    </Link>
  );
}
