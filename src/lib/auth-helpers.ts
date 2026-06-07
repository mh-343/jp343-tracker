export function isAuthFailure(
  result: { success: boolean; data?: { code?: string } },
  hasToken = true,
): boolean {
  if (result.success) return false;
  const code = result.data?.code;
  if (code === 'invalid_token') return hasToken;
  return code === 'E001' || code === 'invalid_nonce';
}
