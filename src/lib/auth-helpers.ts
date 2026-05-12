export function isAuthFailure(result: { success: boolean; data?: { code?: string } }): boolean {
  if (result.success) return false;
  const code = result.data?.code;
  return code === 'invalid_token' || code === 'E001' || code === 'invalid_nonce';
}
