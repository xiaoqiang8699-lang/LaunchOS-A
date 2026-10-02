'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminAiGrowthTabs } from '@/components/admin/admin-ai-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Opportunity = {
  userId: string;
  email: string;
  name: string;
  projectCount: number;
  deploySuccessCount: number;
  planCode: string;
  reason: string;
  source: string;
};

type Payload = {
  total: number;
  items: Opportunity[];
  note?: string;
};

export default function AdminAiGrowthOpportunitiesPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Payload>('/admin/ai-growth/opportunities')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader title="升级机会" description="高活跃 Free 用户候选（仅分析，不自动沟通或改套餐）" />
      <AdminAiGrowthTabs />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      {data?.note ? <InlineAlert tone="info" title={data.note} /> : null}

      {!data ? (
        <Skeleton className="h-40" />
      ) : (
        <Section title={`可能升级用户（${data.total}）`}>
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">用户</th>
                  <th className="px-3 py-2 font-medium">项目</th>
                  <th className="px-3 py-2 font-medium">成功部署</th>
                  <th className="px-3 py-2 font-medium">套餐</th>
                  <th className="px-3 py-2 font-medium">原因</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 ? (
                  <tr>
                    <td className="px-3 py-4 text-zinc-500" colSpan={5}>
                      暂无升级机会
                    </td>
                  </tr>
                ) : (
                  data.items.map((row) => (
                    <tr key={row.userId} className="border-b border-zinc-100 last:border-0">
                      <td className="px-3 py-3">
                        <Link className="font-medium underline" href={`/admin/users/${row.userId}`}>
                          {row.name || row.email}
                        </Link>
                        <p className="text-xs text-zinc-500">{row.email}</p>
                      </td>
                      <td className="px-3 py-3 tabular-nums">{row.projectCount}</td>
                      <td className="px-3 py-3 tabular-nums">{row.deploySuccessCount}</td>
                      <td className="px-3 py-3">{row.planCode}</td>
                      <td className="px-3 py-3 text-zinc-600">{row.reason}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}
