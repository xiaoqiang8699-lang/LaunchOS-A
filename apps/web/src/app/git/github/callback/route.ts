import { NextResponse } from 'next/server';

/**
 * GitHub App Setup URL / Callback URL must point here (Web origin).
 *
 * Local:  http://localhost:3000/git/github/callback
 * Alpha:  https://web-launchos.zsaos.com/git/github/callback
 *
 * We forward installation_id / setup_action / state to the API handler:
 *   {NEXT_PUBLIC_API_URL}/api/v1/git/github/callback
 * which validates state and 302s back into LaunchOS (safe returnTo).
 */
export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const apiBase = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').replace(/\/$/, '');

  // Refuse to bridge into a localhost API when this request itself is public HTTPS.
  if (
    incoming.protocol === 'https:' &&
    /localhost|127\.0\.0\.1/i.test(apiBase)
  ) {
    return NextResponse.json(
      {
        message: 'GitHub 回调地址不是公网 HTTPS 地址',
        code: 'GITHUB_CALLBACK_NOT_PUBLIC',
      },
      { status: 503 },
    );
  }

  const target = new URL(`${apiBase}/api/v1/git/github/callback`);
  for (const key of ['installation_id', 'setup_action', 'state']) {
    const value = incoming.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  return NextResponse.redirect(target.toString(), 302);
}
