import { redirect } from 'next/navigation';

/** Commercial hub alias — subscriptions console lives at /admin/subscriptions */
export default function AdminCommercialSubscriptionsPage() {
  redirect('/admin/subscriptions');
}
