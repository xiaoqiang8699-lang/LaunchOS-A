/**
 * Step 29 Phase 2 — Certificate materialization planning (no private key in outputs).
 */
import { createHash } from 'node:crypto';
import { DEFAULT_WILDCARD_CERT_DIR } from './cert-install.js';
import { STEP29_GATEWAY_WHITELIST } from './gateway-access.js';
import { GATEWAY_LAYOUT } from './gateway-runtime.js';

export type CertificateMaterialSource =
  | 'SYSTEM_DOMAIN_TLS_HINT'
  | 'EXISTING_GATEWAY_HOST'
  | 'MISSING';

export type CertificateMaterialFacts = {
  certificateId: string | null;
  commonName: string | null;
  certificateValid: boolean;
  coversApiHostname: boolean;
  coversWebHostname: boolean;
  /** True only when fullchain+privkey files are known to exist somewhere controllable. */
  certificateMaterialAvailable: boolean;
  certificateInstallRequired: boolean;
  source: CertificateMaterialSource;
  sourceHost: string | null;
  sourcePathHint: string | null;
  plannedTargetDir: string;
  plannedFullchainPath: string;
  plannedPrivkeyPath: string;
  /** Fingerprint of fullchain when available — never key material. */
  certificateFingerprint: string | null;
};

export type CertificateInstallPlan = {
  sourceHost: string;
  sourceFullchain: string;
  sourcePrivkey: string;
  targetDir: string;
  targetFullchain: string;
  targetPrivkey: string;
  chmodCommands: string[];
  /** Never logs key contents. */
  auditSafeNote: string;
};

export function planCertificatePaths(certificateId: string): {
  targetDir: string;
  fullchain: string;
  privkey: string;
} {
  const safeId = certificateId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'wildcard';
  const targetDir = `${GATEWAY_LAYOUT.certificates}/${safeId}`;
  return {
    targetDir,
    fullchain: `${targetDir}/fullchain.pem`,
    privkey: `${targetDir}/privkey.pem`,
  };
}

export function fingerprintCertificatePem(fullchainPem: string): string {
  return createHash('sha256').update(fullchainPem, 'utf8').digest('hex');
}

/**
 * Resolve material availability from read-only probes (no key bytes in return value).
 */
export function resolveCertificateMaterialFacts(input: {
  certificateId?: string | null;
  commonName?: string | null;
  expiresAt?: Date | string | null;
  coversApiHostname: boolean;
  coversWebHostname: boolean;
  /** Files exist on managed target already. */
  presentOnTarget?: boolean;
  /** Files exist on known source host (e.g. previous gateway). */
  presentOnSourceHost?: boolean;
  sourceHost?: string | null;
  sourcePathHint?: string | null;
  fullchainFingerprint?: string | null;
}): CertificateMaterialFacts {
  const exp = input.expiresAt ? new Date(input.expiresAt) : null;
  const notExpired = Boolean(exp && !Number.isNaN(exp.getTime()) && exp.getTime() > Date.now());
  const certificateValid =
    notExpired && input.coversApiHostname && input.coversWebHostname && Boolean(input.commonName);
  const paths = planCertificatePaths(input.certificateId || 'wildcard-zsaos');
  const presentOnTarget = Boolean(input.presentOnTarget);
  const presentOnSource = Boolean(input.presentOnSourceHost);
  const available = presentOnTarget || presentOnSource;
  let source: CertificateMaterialSource = 'MISSING';
  if (presentOnTarget) source = 'SYSTEM_DOMAIN_TLS_HINT';
  else if (presentOnSource) source = 'EXISTING_GATEWAY_HOST';

  return {
    certificateId: input.certificateId || null,
    commonName: input.commonName || null,
    certificateValid,
    coversApiHostname: input.coversApiHostname,
    coversWebHostname: input.coversWebHostname,
    certificateMaterialAvailable: available,
    certificateInstallRequired: certificateValid && !presentOnTarget && presentOnSource,
    source,
    sourceHost: presentOnSource ? input.sourceHost || null : null,
    sourcePathHint: input.sourcePathHint || DEFAULT_WILDCARD_CERT_DIR,
    plannedTargetDir: paths.targetDir,
    plannedFullchainPath: paths.fullchain,
    plannedPrivkeyPath: paths.privkey,
    certificateFingerprint: input.fullchainFingerprint || null,
  };
}

export function planCertificateInstall(facts: CertificateMaterialFacts): CertificateInstallPlan | null {
  if (!facts.certificateMaterialAvailable) return null;
  if (!facts.certificateInstallRequired) return null;
  if (!facts.sourceHost || !facts.sourcePathHint) return null;
  return {
    sourceHost: facts.sourceHost,
    sourceFullchain: `${facts.sourcePathHint}/fullchain.pem`,
    sourcePrivkey: `${facts.sourcePathHint}/privkey.pem`,
    targetDir: facts.plannedTargetDir,
    targetFullchain: facts.plannedFullchainPath,
    targetPrivkey: facts.plannedPrivkeyPath,
    chmodCommands: [
      `mkdir -p ${facts.plannedTargetDir}`,
      'chmod 700 ' + facts.plannedTargetDir,
      `chmod 644 ${facts.plannedFullchainPath}`,
      `chmod 600 ${facts.plannedPrivkeyPath}`,
    ],
    auditSafeNote: `materialize wildcard for ${STEP29_GATEWAY_WHITELIST.web.hostname}+${STEP29_GATEWAY_WHITELIST.api.hostname} without logging key bytes`,
  };
}

export function certificateMaterialBlocker(
  facts: CertificateMaterialFacts,
): { code: 'CERTIFICATE_MATERIAL_UNAVAILABLE'; message: string } | null {
  if (facts.certificateValid && !facts.certificateMaterialAvailable) {
    return {
      code: 'CERTIFICATE_MATERIAL_UNAVAILABLE',
      message: 'certificate metadata valid but fullchain/privkey material not found in controlled store',
    };
  }
  return null;
}
