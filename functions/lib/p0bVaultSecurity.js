'use strict'

// STEP1000C7R: Verify Cloud Storage policy before using an IAM-only vault.
// The Firebase Storage emulator cannot replace a real-bucket IAM audit.
async function requireProtectedVault(getVaultBucket, stagingBucket, HttpsError) {
  const deny = () => {
    throw new HttpsError('failed-precondition',
      'Secure Listening media storage is not configured.')
  }
  if (typeof getVaultBucket !== 'function') return deny()
  let vault
  try { vault = getVaultBucket() } catch (_) { return deny() }
  if (!vault || typeof vault.name !== 'string' ||
      !vault.name || vault.name === stagingBucket?.name ||
      typeof vault.getMetadata !== 'function') return deny()
  let policy
  try {
    ;[policy] = await vault.getMetadata()
  } catch (_) {
    // Do not expose details about bucket names, identities or IAM failures.
    return deny()
  }
  if (policy?.name !== vault.name ||
      policy?.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true ||
      policy?.iamConfiguration?.publicAccessPrevention !== 'enforced') return deny()
  return vault
}

module.exports = { requireProtectedVault }
