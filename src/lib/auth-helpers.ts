import type { AuthTransition, JP343UserState } from '../types';

export function isAuthFailure(
  result: { success?: boolean; data?: unknown },
  hasToken = true,
): boolean {
  if (result.success) return false;
  const data = result.data as Record<string, unknown> | undefined;
  const code = typeof data?.code === 'string' ? data.code : undefined;
  if (code === 'invalid_token') return hasToken;
  return code === 'E001' || code === 'invalid_nonce';
}

export function isStableUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function stableUserId(state: JP343UserState | null | undefined): number | null {
  return isStableUserId(state?.userId) ? state.userId : null;
}

export function normalizeAjaxUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') {
      const host = parsed.hostname;
      return host === 'jp343.com' || host.endsWith('.jp343.com') ? url : null;
    }
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    return import.meta.env.DEV && isLocal ? url : null;
  } catch {
    return null;
  }
}

export const LOGGED_OUT_USER_STATE: JP343UserState = {
  isLoggedIn: false,
  userId: null,
  nonce: null,
  ajaxUrl: null,
  extApiToken: null,
  avatarUrlSmall: null
};

export interface AuthMergeResult {
  state: JP343UserState;
  identityChanged: boolean;
  rejected: boolean;
}

function loggedOut(previousId: number | null): AuthMergeResult {
  return {
    state: { ...LOGGED_OUT_USER_STATE },
    identityChanged: previousId !== null,
    rejected: false
  };
}

export function mergeAuthState(
  previous: JP343UserState | null | undefined,
  incoming: Partial<JP343UserState> | null | undefined,
  transition: AuthTransition
): AuthMergeResult {
  const previousId = stableUserId(previous);

  if (transition === 'explicit-logout') return loggedOut(previousId);

  const claimsAnonymous = incoming?.isLoggedIn === false;
  const incomingId = !claimsAnonymous && isStableUserId(incoming?.userId) ? incoming.userId : null;

  if (incomingId === null) {
    if (transition === 'authoritative') {
      return {
        state: previous ? { ...previous } : { ...LOGGED_OUT_USER_STATE },
        identityChanged: false,
        rejected: true
      };
    }
    const keepsValidLogin = previous !== null && previous !== undefined
      && previousId !== null
      && previous.extApiToken !== null;
    if (!keepsValidLogin) return loggedOut(previousId);
    return {
      state: { ...previous, isLoggedIn: true, nonce: null },
      identityChanged: false,
      rejected: false
    };
  }

  const sameUser = previousId !== null && previousId === incomingId;
  const carried = sameUser && previous ? previous : null;
  const avatarProvided = incoming !== null && incoming !== undefined && 'avatarUrlSmall' in incoming;

  return {
    state: {
      isLoggedIn: true,
      userId: incomingId,
      nonce: incoming?.nonce ?? carried?.nonce ?? null,
      ajaxUrl: normalizeAjaxUrl(incoming?.ajaxUrl) ?? carried?.ajaxUrl ?? null,
      extApiToken: incoming?.extApiToken ?? carried?.extApiToken ?? null,
      avatarUrlSmall: avatarProvided
        ? (incoming.avatarUrlSmall ?? null)
        : (carried?.avatarUrlSmall ?? null)
    },
    identityChanged: previousId !== null && previousId !== incomingId,
    rejected: false
  };
}

export function isCacheableUserState(state: JP343UserState | null | undefined): boolean {
  return stableUserId(state) !== null;
}

export function hasUsableAuth(state: JP343UserState | null | undefined): boolean {
  if (stableUserId(state) === null) return false;
  if (state?.extApiToken) return true;
  return !!state?.nonce && normalizeAjaxUrl(state.ajaxUrl) !== null;
}
