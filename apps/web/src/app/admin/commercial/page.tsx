'use client';

import Link from 'next/link';
import { PageHeader, Section } from '@/components/ui/section';
import { Card } from '@/components/ui/section';

const TABS = [
  { href: '/admin/subscriptions', label: '订阅', desc: '全部订阅与生命周期操作' },
  { href: '/admin/plans', label: '套餐', desc: 'Free / Pro / Team / Enterprise' },
  { href: '/admin/orders', label: '订单', desc: 'CommercialOrder 记录' },
  { href: '/admin/payments', label: '支付', desc: '支付与渠道状态' },
  { href: '/admin/invoices', label: '发票', desc: '账单与结算' },
  { href: '/admin/upgrade-requests', label: '升级申请', desc: '人工审批入口' },
  { href: '/admin/payment-providers', label: '支付渠道', desc: 'Alipay 等配置（只读为主）' },
];

export default function AdminCommercialPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="商业与订阅"
        description="订阅、订单、支付、退款与发票。本页不触发真实支付。"
      />
      <Section title="模块">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TABS.map((tab) => (
            <Link key={tab.href} href={tab.href}>
              <Card className="h-full p-4 transition hover:border-zinc-400">
                <p className="font-semibold">{tab.label}</p>
                <p className="mt-1 text-sm text-zinc-500">{tab.desc}</p>
              </Card>
            </Link>
          ))}
        </div>
      </Section>
    </div>
  );
}
