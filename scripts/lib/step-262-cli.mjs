/**
 * Shared CLI flag parsing for Step 26.2 e2e scripts.
 * Supports:
 *   --cloud-resource-id=abc
 *   --cloud-resource-id abc
 */

/**
 * @param {string[]} argv process.argv (or a slice)
 * @returns {{ cloudResourceId: string | null, confirmBilling: boolean }}
 */
export function parseStep262Argv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let cloudResourceId = null;
  let confirmBilling = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    if (arg === '--confirm-billing') {
      confirmBilling = true;
      continue;
    }
    if (arg.startsWith('--cloud-resource-id=')) {
      const value = arg.slice('--cloud-resource-id='.length).trim();
      cloudResourceId = value || null;
      continue;
    }
    if (arg === '--cloud-resource-id') {
      const next = args[i + 1];
      if (next && !String(next).startsWith('--')) {
        cloudResourceId = String(next).trim() || null;
        i += 1;
      } else {
        cloudResourceId = null;
      }
    }
  }

  return { cloudResourceId, confirmBilling };
}
