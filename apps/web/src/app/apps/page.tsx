import { redirect } from 'next/navigation';

/** Legacy /apps → My Apps */
export default function AppsRedirectPage() {
  redirect('/projects');
}
