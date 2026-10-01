import Link from 'next/link';
import { PublicFooter, PublicHeader } from '@/components/public-site';

const plans = [
  { id: 'free', name: 'Free', price: '免费', text: '适合第一次体验 LaunchOS。' },
  { id: 'pro', name: 'Pro', price: '¥99/月', text: '适合独立开发者和小型线上项目。' },
  { id: 'team', name: 'Team', price: '¥299/月', text: '适合小团队和商业项目。' },
  { id: 'enterprise', name: 'Enterprise', price: '联系销售', text: '适合需要单独约定的企业使用方式。' },
];

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <PublicHeader />
      <main className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-semibold">套餐</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-600">
          LaunchOS 按套餐收取软件服务费。下面是当前公开价格，不包含你实际使用的云资源费用。
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {plans.map((plan) => (
            <article id={plan.id} key={plan.id} className="rounded-xl border border-zinc-200 bg-white p-5">
              <h2 className="text-xl font-semibold">{plan.name}</h2>
              <p className="mt-2 text-lg font-medium">{plan.price}</p>
              <p className="mt-2 text-sm leading-6 text-zinc-600">{plan.text}</p>
            </article>
          ))}
        </div>
        <Link className="mt-8 inline-block rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white" href="/register">
          开始使用
        </Link>
      </main>
      <PublicFooter />
    </div>
  );
}
