import { createSign, createVerify, createPublicKey, createPrivateKey, createHash } from 'node:crypto';

function wrapPem(kind: 'PRIVATE KEY' | 'RSA PRIVATE KEY' | 'PUBLIC KEY', value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('BEGIN')) return trimmed;
  const body = trimmed.replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN ${kind}-----\n${lines}\n-----END ${kind}-----`;
}

/**
 * Alipay OpenAPI request signing:
 * exclude only `sign` (empty values too). `sign_type` MUST be included.
 *
 * Async notify verification:
 * exclude both `sign` and `sign_type`.
 */
export function canonicalAlipayPayload(
  params: Record<string, string>,
  mode: 'request' | 'notify' = 'notify',
): string {
  const skip = mode === 'request' ? new Set(['sign']) : new Set(['sign', 'sign_type']);
  return Object.keys(params)
    .filter((key) => !skip.has(key) && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

function privateKeyCandidates(value: string): string[] {
  if (value.includes('BEGIN')) return [value.trim()];
  return [wrapPem('PRIVATE KEY', value), wrapPem('RSA PRIVATE KEY', value)];
}

export function signAlipayContent(content: string, privateKey: string): string {
  let last: unknown;
  for (const candidate of privateKeyCandidates(privateKey)) {
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(content, 'utf8');
      return signer.sign(candidate, 'base64');
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error('KEY_INVALID');
}

/** Merchant → Alipay request signature (RSA2). Includes sign_type. */
export function signAlipayParams(params: Record<string, string>, privateKey: string): string {
  return signAlipayContent(canonicalAlipayPayload(params, 'request'), privateKey);
}

export function verifyAlipayContent(content: string, signature: string, publicKey: string): boolean {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(content, 'utf8');
    return verifier.verify(wrapPem('PUBLIC KEY', publicKey), signature, 'base64');
  } catch {
    return false;
  }
}

/** Alipay → merchant notify verification. Excludes sign + sign_type. */
export function verifyAlipayParams(params: Record<string, string>, publicKey: string): boolean {
  if (!params.sign) return false;
  return verifyAlipayContent(canonicalAlipayPayload(params, 'notify'), params.sign, publicKey);
}

export function privateKeyCanSign(privateKey: string): boolean {
  try {
    signAlipayContent('launchos-config-check', privateKey);
    return true;
  } catch {
    return false;
  }
}

export function publicKeyParses(publicKey: string): boolean {
  try {
    createPublicKey(wrapPem('PUBLIC KEY', publicKey));
    return true;
  } catch {
    return false;
  }
}

/** Self-check: sign with app private key, verify with derived app public key. */
export function selfSignVerify(privateKey: string, sample = 'launchos-alipay-signature-self-test'): boolean {
  try {
    const signature = signAlipayContent(sample, privateKey);
    const keyObj = (() => {
      for (const candidate of privateKeyCandidates(privateKey)) {
        try {
          return createPrivateKey(candidate);
        } catch {
          /* try next */
        }
      }
      return null;
    })();
    if (!keyObj) return false;
    const pub = createPublicKey(keyObj).export({ type: 'spki', format: 'pem' }).toString();
    return verifyAlipayContent(sample, signature, pub);
  } catch {
    return false;
  }
}

export function materialFingerprint(value: string): string {
  return createHash('sha256').update(value.replace(/\s+/g, '')).digest('hex').slice(0, 16);
}

export function stringifyParams(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}
