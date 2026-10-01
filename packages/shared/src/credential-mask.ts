/** Mask AccessKeyId for admin display, e.g. LTAI****ABCD */
export function maskAccessKeyId(accessKeyId: string): string {
  const trimmed = accessKeyId.trim();
  if (trimmed.length <= 8) {
    return '****';
  }
  const head = trimmed.slice(0, 4);
  const tail = trimmed.slice(-4);
  return `${head}****${tail}`;
}

export const MASKED_SECRET = '********';
