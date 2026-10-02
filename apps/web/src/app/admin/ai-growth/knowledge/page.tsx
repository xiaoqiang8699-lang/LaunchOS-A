'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminAiGrowthTabs } from '@/components/admin/admin-ai-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';

type Item = {
  id: string;
  title: string;
  category: string;
  sourceType: string;
  usageCount: number;
  successRate: number;
  updatedAt: string;
  description: string;
  rootCause: string;
  solutionSteps: string[];
};

type Candidate = {
  id: string;
  summary: string;
  category: string;
  solution: string;
  status: string;
  deploymentId: string;
  createdAt: string;
};

type Payload = { items: Item[]; candidates: Candidate[] };

export default function AdminKnowledgePage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Item | null>(null);
  const [msg, setMsg] = useState('');

  async function load(query = q) {
    try {
      const path = `/admin/ai-growth/knowledge${query ? `?q=${encodeURIComponent(query)}` : ''}`;
      setData(await api<Payload>(path));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '加载失败');
    }
  }

  useEffect(() => {
    void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function review(id: string, decision: 'APPROVED' | 'REJECTED') {
    setMsg('');
    try {
      await api(`/admin/deployment-knowledge/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      setMsg(decision === 'APPROVED' ? '已批准并入库' : '已拒绝候选');
      await load();
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : '审核失败');
    }
  }

  async function scan() {
    setMsg('');
    try {
      const result = await api<{ scanned: number; created: number }>('/admin/ai-growth/knowledge/scan', {
        method: 'POST',
      });
      setMsg(`扫描 ${result.scanned} 次成功部署，新增候选 ${result.created}`);
      await load();
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : '扫描失败');
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="部署知识库"
        description="沉淀部署失败经验，优先匹配历史验证方案"
        action={
          <div className="flex flex-wrap gap-2">
            <Link
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm"
              href="/admin/ai-growth/knowledge/analytics"
            >
              统计分析
            </Link>
            <button
              type="button"
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white"
              onClick={() => void scan()}
            >
              扫描候选
            </button>
          </div>
        }
      />
      <AdminAiGrowthTabs />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      {msg ? <InlineAlert tone="info" title={msg} /> : null}

      <div className="flex flex-wrap gap-2">
        <input
          className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
          placeholder="搜索标题/描述"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          type="button"
          className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
          onClick={() => void load(q)}
        >
          搜索
        </button>
      </div>

      {!data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          {data.candidates.length > 0 ? (
            <Section title="待审核候选">
              <div className="space-y-2">
                {data.candidates.map((c) => (
                  <Card key={c.id} className="space-y-2 p-4 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{c.summary}</p>
                      <StatusBadge status={c.status} label={c.status} tone="warning" />
                    </div>
                    <p className="text-xs text-zinc-500">
                      {c.category} · 部署 {c.deploymentId.slice(0, 10)}…
                    </p>
                    <p>方案：{c.solution}</p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs text-white"
                        onClick={() => void review(c.id, 'APPROVED')}
                      >
                        批准
                      </button>
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs"
                        onClick={() => void review(c.id, 'REJECTED')}
                      >
                        拒绝
                      </button>
                    </div>
                  </Card>
                ))}
              </div>
            </Section>
          ) : null}

          <Section title="知识列表">
            <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">标题</th>
                    <th className="px-4 py-2 font-medium">分类</th>
                    <th className="px-4 py-2 font-medium">来源</th>
                    <th className="px-4 py-2 font-medium">使用</th>
                    <th className="px-4 py-2 font-medium">成功率</th>
                    <th className="px-4 py-2 font-medium">更新</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr
                      key={item.id}
                      className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
                      onClick={() => setSelected(item)}
                    >
                      <td className="px-4 py-3 font-medium">{item.title}</td>
                      <td className="px-4 py-3">{item.category}</td>
                      <td className="px-4 py-3">{item.sourceType}</td>
                      <td className="px-4 py-3 tabular-nums">{item.usageCount}</td>
                      <td className="px-4 py-3 tabular-nums">
                        {(item.successRate * 100).toFixed(0)}%
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500">
                        {new Date(item.updatedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {selected ? (
            <Section title="知识详情">
              <Card className="space-y-2 p-4 text-sm">
                <p className="text-lg font-medium">{selected.title}</p>
                <p>问题：{selected.description || selected.title}</p>
                <p>原因：{selected.rootCause}</p>
                <p>解决方案：</p>
                <ol className="list-decimal space-y-1 pl-5">
                  {selected.solutionSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <p className="text-xs text-zinc-500">
                  效果：成功解决相关反馈 {(selected.successRate * 100).toFixed(0)}% · 使用{' '}
                  {selected.usageCount} 次
                </p>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs"
                  onClick={() => setSelected(null)}
                >
                  关闭
                </button>
              </Card>
            </Section>
          ) : null}
        </>
      )}
    </div>
  );
}
