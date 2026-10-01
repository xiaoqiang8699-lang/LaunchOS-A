import Link from 'next/link';

export function PublicHeader() {
  return (
    <header className="border-b border-zinc-200 bg-white">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link className="text-base font-semibold text-zinc-900" href="/">
          LaunchOS
        </Link>
        <nav className="flex flex-wrap items-center gap-2 text-sm">
          <Link className="rounded-lg px-3 py-1.5 text-zinc-700 hover:bg-zinc-100" href="/#product">
            产品
          </Link>
          <Link className="rounded-lg px-3 py-1.5 text-zinc-700 hover:bg-zinc-100" href="/pricing">
            套餐
          </Link>
          <Link className="rounded-lg px-3 py-1.5 text-zinc-700 hover:bg-zinc-100" href="/login">
            登录
          </Link>
          <Link className="rounded-lg bg-zinc-900 px-3 py-1.5 text-white" href="/register">
            开始使用
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-zinc-200 bg-white">
      <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-8 text-sm text-zinc-600 sm:px-6">
        <p>套餐费用不包含实际云资源费用。云资源费用根据你使用的服务器、数据库等另行产生。</p>
        <nav className="flex flex-wrap gap-4">
          <Link className="underline" href="/login">
            登录
          </Link>
          <Link className="underline" href="/register">
            注册
          </Link>
          <Link className="underline" href="/privacy">
            隐私政策
          </Link>
          <Link className="underline" href="/terms">
            服务条款
          </Link>
        </nav>
      </div>
    </footer>
  );
}
