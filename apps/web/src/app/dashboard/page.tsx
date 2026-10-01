import { redirect } from 'next/navigation';

/** Legacy dashboard → Overview (servers tab preserved) */
export default async function DashboardRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  if (sp.tab === 'servers') {
    redirect('/servers');
  }
  redirect('/overview');
}
