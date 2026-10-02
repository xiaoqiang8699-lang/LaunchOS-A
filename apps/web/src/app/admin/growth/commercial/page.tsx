'use client';

import { useEffect, useState } from 'react';
import { AdminGrowthTabs } from '@/components/admin/admin-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Commercial = {
  distribution: { free: number; pro: number; team: number; enterprise: number };
  conversion: {
    freeUsers: number;
    planViewed: number;
    upgradeRequested: number;
    upgraded: number;
  };
  note: string;
};

export default function AdminGrowthCommercialPage() {
  const [data, setData] = useState<Commercial | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Commercial>('/admin/growth/commercial')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader title="商业分析" description="套餐分布与升级转化（Beta 不统计真实收入）" />
      <AdminGrowthTabs />
      {error ? <InlineAlert tone="error" title={error} /> : null}

      {!data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <InlineAlert tone="info" title={data.note} />

          <Section title="套餐分布">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Free" value={data.distribution.free} />
              <Metric label="Pro" value={data.distribution.pro} />
              <Metric label="Team" value={data.distribution.team} />
              <Metric label="Enterprise" value={data.distribution.enterprise} />
            </div>
          </Section>

          <Section title="转化漏斗">
            <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">阶段</th>
                    <th className="px-4 py-2 font-medium">数量</th>
                  </tr>
                </thead>
                <tbody>
                  <Row label="Free 用户数量" value={data.conversion.freeUsers} />
                  <Row label="查看套餐人数" value={data.conversion.planViewed} />
                  <Row label="发起升级人数" value={data.conversion.upgradeRequested} />
                  <Row label="完成升级人数" value={data.conversion.upgraded} />
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function Metric(props: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-zinc-500">{props.label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{props.value}</p>
    </Card>
  );
}

function Row(props: { label: string; value: number }) {
  return (
    <tr className="border-b border-zinc-100 last:border-0">
      <td className="px-4 py-3 font-medium text-zinc-900">{props.label}</td>
      <td className="px-4 py-3 tabular-nums text-zinc-800">{props.value}</td>
    </tr>
  );
}
