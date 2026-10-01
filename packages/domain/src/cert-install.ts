export const DEFAULT_WILDCARD_CERT_DIR =
  '/www/server/panel/vhost/cert/launchos-wildcard-zsaos';

export type CertLayout = {
  currentDir: string;
  previousDir: string;
  stagingDir: string;
  fullchain: string;
  privkey: string;
};

export function certLayout(baseDir = DEFAULT_WILDCARD_CERT_DIR): CertLayout {
  const currentDir = baseDir.replace(/\/$/, '');
  return {
    currentDir,
    previousDir: `${currentDir}/previous`,
    stagingDir: `${currentDir}/staging`,
    fullchain: `${currentDir}/fullchain.pem`,
    privkey: `${currentDir}/privkey.pem`,
  };
}

/**
 * Shell steps for atomic install. Callers execute remotely.
 * Never echo private key contents.
 */
export function buildAtomicInstallScript(options: {
  acmeCertDir: string;
  layout?: CertLayout;
  nginxBin?: string;
  vhostConf?: string;
}): string {
  const layout = options.layout ?? certLayout();
  const nginx = options.nginxBin ?? '/www/server/nginx/sbin/nginx';
  const acme = options.acmeCertDir;
  return [
    'set -euo pipefail',
    `ACME_DIR="${acme}"`,
    `CURRENT="${layout.currentDir}"`,
    `PREV="${layout.previousDir}"`,
    `STAGING="${layout.stagingDir}"`,
    'test -f "$ACME_DIR/fullchain.cer"',
    'test -f "$ACME_DIR/*.zsaos.com.key" || test -f "$ACME_DIR/$(ls "$ACME_DIR" | grep -E "\\.key$" | head -n1)"',
    'KEY_FILE=$(ls "$ACME_DIR"/*.key 2>/dev/null | head -n1)',
    'test -n "$KEY_FILE"',
    'mkdir -p "$STAGING" "$PREV" "$CURRENT"',
    'chmod 700 "$CURRENT" "$STAGING" "$PREV"',
    'cp -f "$ACME_DIR/fullchain.cer" "$STAGING/fullchain.pem"',
    'cp -f "$KEY_FILE" "$STAGING/privkey.pem"',
    'chmod 644 "$STAGING/fullchain.pem"',
    'chmod 600 "$STAGING/privkey.pem"',
    // Validate cert before touching live files
    'openssl x509 -in "$STAGING/fullchain.pem" -noout -subject -issuer -dates >/tmp/launchos-cert-meta.txt',
    'openssl x509 -noout -modulus -in "$STAGING/fullchain.pem" 2>/dev/null | openssl md5 >/tmp/launchos-cert-mod.txt',
    'openssl rsa -noout -modulus -in "$STAGING/privkey.pem" 2>/dev/null | openssl md5 >/tmp/launchos-key-mod.txt',
    'cmp /tmp/launchos-cert-mod.txt /tmp/launchos-key-mod.txt',
    // Preserve previous live cert if present
    'if [ -f "$CURRENT/fullchain.pem" ]; then cp -f "$CURRENT/fullchain.pem" "$PREV/fullchain.pem"; fi',
    'if [ -f "$CURRENT/privkey.pem" ]; then cp -f "$CURRENT/privkey.pem" "$PREV/privkey.pem"; chmod 600 "$PREV/privkey.pem"; fi',
    // Atomic-ish switch via rename within same filesystem
    'cp -f "$STAGING/fullchain.pem" "$CURRENT/fullchain.pem.new"',
    'cp -f "$STAGING/privkey.pem" "$CURRENT/privkey.pem.new"',
    'chmod 644 "$CURRENT/fullchain.pem.new"',
    'chmod 600 "$CURRENT/privkey.pem.new"',
    'mv -f "$CURRENT/fullchain.pem.new" "$CURRENT/fullchain.pem"',
    'mv -f "$CURRENT/privkey.pem.new" "$CURRENT/privkey.pem"',
    `${nginx} -t`,
    'echo ATOMIC_INSTALL_OK',
    'cat /tmp/launchos-cert-meta.txt',
  ].join('\n');
}

export function buildRollbackCertScript(options?: {
  layout?: CertLayout;
  nginxBin?: string;
}): string {
  const layout = options?.layout ?? certLayout();
  const nginx = options?.nginxBin ?? '/www/server/nginx/sbin/nginx';
  return [
    'set -euo pipefail',
    `CURRENT="${layout.currentDir}"`,
    `PREV="${layout.previousDir}"`,
    'test -f "$PREV/fullchain.pem"',
    'test -f "$PREV/privkey.pem"',
    'cp -f "$PREV/fullchain.pem" "$CURRENT/fullchain.pem"',
    'cp -f "$PREV/privkey.pem" "$CURRENT/privkey.pem"',
    'chmod 644 "$CURRENT/fullchain.pem"',
    'chmod 600 "$CURRENT/privkey.pem"',
    `${nginx} -t`,
    `${nginx} -s reload`,
    'echo ROLLBACK_OK',
  ].join('\n');
}

export function buildNginxTestReloadScript(nginxBin = '/www/server/nginx/sbin/nginx'): string {
  return ['set -euo pipefail', `${nginxBin} -t`, `${nginxBin} -s reload`, 'echo RELOAD_OK'].join(
    '\n',
  );
}
