import Link from 'next/link';
import { PublicFooter, PublicHeader } from '@/components/public-site';

const capabilities = [
  { title: '连接代码', text: '选择 GitHub 项目' },
  { title: '智能检测', text: '自动识别应用和所需资源' },
  { title: '一键上线', text: '确认方案后自动完成部署和公网访问' },
];

const audiences = [
  { title: '独立开发者', text: '一个人也能把应用发布到公网。' },
  { title: '小团队', text: '几个人一起维护项目、确认方案并上线。' },
  { title: '商业项目', text: '按套餐使用 LaunchOS，云资源费用单独计算。' },
];

const plans = [
  { name: 'Free', price: '免费', href: '/pricing#free' },
  { name: 'Pro', price: '¥99/月', href: '/pricing#pro' },
  { name: 'Team', price: '¥299/月', href: '/pricing#team' },
  { name: 'Enterprise', price: '联系销售', href: '/pricing#enterprise' },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <PublicHeader />
      <main>
        <section className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-20">
          <p className="text-sm font-semibold text-zinc-900">LaunchOS</p>
          <h1 className="mt-3 max-w-3xl text-3xl font-semibold tracking-tight sm:text-5xl">不会部署，也能把应用上线</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-600 sm:text-lg">
            连接你的代码，LaunchOS 会自动分析应用、准备上线方案并帮助你发布到公网。
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link className="rounded-lg bg-zinc-900 px-4 py-2.5 text-center text-sm font-medium text-white" href="/register">
              开始使用
            </Link>
            <Link className="rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-center text-sm font-medium text-zinc-900" href="/pricing">
              查看套餐
            </Link>
          </div>
        </section>

        <section id="product" className="mx-auto grid w-full max-w-5xl gap-4 px-4 pb-12 sm:grid-cols-3 sm:px-6">
          {capabilities.map((item) => (
            <article key={item.title} className="rounded-xl border border-zinc-200 bg-white p-5">
              <h2 className="text-lg font-semibold">{item.title}</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-600">{item.text}</p>
            </article>
          ))}
        </section>

        <section className="mx-auto w-full max-w-5xl px-4 pb-12 sm:px-6">
          <h2 className="text-2xl font-semibold">适合谁使用</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {audiences.map((item) => (
              <article key={item.title} className="rounded-xl border border-zinc-200 bg-white p-5">
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-600">{item.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-5xl px-4 pb-12 sm:px-6">
          <h2 className="text-2xl font-semibold">三步上线</h2>
          <ol className="mt-4 grid gap-4 sm:grid-cols-3">
            {capabilities.map((item, index) => (
              <li key={item.title} className="rounded-xl border border-zinc-200 bg-white p-5">
                <p className="text-sm text-zinc-500">{index + 1}</p>
                <h3 className="mt-2 font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-600">{item.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mx-auto w-full max-w-5xl px-4 pb-16 sm:px-6">
          <h2 className="text-2xl font-semibold">套餐</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {plans.map((plan) => (
              <Link key={plan.name} className="rounded-xl border border-zinc-200 bg-white p-5 hover:border-zinc-400" href={plan.href}>
                <h3 className="text-lg font-semibold">{plan.name}</h3>
                <p className="mt-3 text-sm font-medium">{plan.price}</p>
              </Link>
            ))}
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
