import type { JP343UserState, PendingEntry } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { ajaxPost, AJAX_URL } from './api';

export async function tryRefreshNonce(userState: JP343UserState): Promise<JP343UserState | null> {
  try {
    const result = await ajaxPost('jp343_extension_nonce_refresh');
    if (result.success && result.data?.nonce) {
      const updated: JP343UserState = {
        ...userState,
        nonce: result.data.nonce as string,
        isLoggedIn: true,
        userId: result.data.userId as number,
        extApiToken: (result.data.extApiToken as string) || userState.extApiToken || null,
      };
      await browser.storage.local.set({ [STORAGE_KEYS.USER]: updated });
      return updated;
    }
  } catch {}
  return null;
}

export async function doLogin(email: string, password: string): Promise<{ success: boolean; error?: string; userState?: JP343UserState }> {
  try {
    const response = await fetch(AJAX_URL, {
      method: 'POST',
      credentials: 'include',
      body: new URLSearchParams({
        action: 'jp343_extension_auth',
        email,
        password
      })
    });

    const text = await response.text();

    let result: { success: boolean; data?: Record<string, unknown> };
    try {
      result = JSON.parse(text);
    } catch {
      return { success: false, error: `Server returned non-JSON (${response.status})` };
    }

    if (result.success && result.data?.nonce) {
      const userState: JP343UserState = {
        isLoggedIn: true,
        userId: result.data.userId as number,
        nonce: result.data.nonce as string,
        ajaxUrl: (result.data.ajaxUrl && /^https:\/\/(.*\.)?jp343\.com\//i.test(result.data.ajaxUrl as string)) ? result.data.ajaxUrl as string : AJAX_URL,
        extApiToken: (result.data.extApiToken as string) || null
      };
      await browser.storage.local.set({
        [STORAGE_KEYS.USER]: userState,
        jp343_extension_display_name: result.data.displayName || null
      });

      browser.runtime.sendMessage({ type: 'SYNC_ENTRIES_DIRECT' }).catch(() => {});

      return { success: true, userState };
    }

    const msg = (result.data?.message as string) || (typeof result.data === 'string' ? result.data : null) || 'Login failed';
    return { success: false, error: msg };
  } catch {
    return { success: false, error: 'Network error \u2014 check your connection' };
  }
}

export async function doRegister(email: string, password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(AJAX_URL, {
      method: 'POST',
      credentials: 'include',
      body: new URLSearchParams({
        action: 'jp343_extension_register',
        email,
        password
      })
    });

    const text = await response.text();

    let result: { success: boolean; data?: Record<string, unknown> };
    try { result = JSON.parse(text); } catch {
      return { success: false, error: `Server returned non-JSON (${response.status})` };
    }

    if (result.success && result.data?.nonce) {
      const userState: JP343UserState = {
        isLoggedIn: true,
        userId: result.data.userId as number,
        nonce: result.data.nonce as string,
        ajaxUrl: (result.data.ajaxUrl && /^https:\/\/(.*\.)?jp343\.com\//i.test(result.data.ajaxUrl as string)) ? result.data.ajaxUrl as string : AJAX_URL,
        extApiToken: (result.data.extApiToken as string) || null
      };
      await browser.storage.local.set({
        [STORAGE_KEYS.USER]: userState,
        jp343_extension_display_name: result.data.displayName || null
      });

      browser.runtime.sendMessage({ type: 'SYNC_ENTRIES_DIRECT' }).catch(() => {});

      return { success: true };
    }

    return { success: false, error: (result.data?.message as string) || 'Registration failed' };
  } catch {
    return { success: false, error: 'Network error \u2014 check your connection' };
  }
}

function requestRefresh(): void {
  document.dispatchEvent(new CustomEvent('jp343:refresh'));
}

export let isLoggingOut = false;

export async function doLogout(): Promise<void> {
  isLoggingOut = true;
  try {
    const r = await fetch(AJAX_URL, {
      method: 'POST',
      credentials: 'include',
      body: new URLSearchParams({ action: 'jp343_extension_logout' })
    });
    await r.text();
  } catch { /* server unreachable is fine, clear local state anyway */ }
  await browser.storage.local.remove([STORAGE_KEYS.USER, STORAGE_KEYS.DISPLAY_NAME]);
  isLoggingOut = false;
  requestRefresh();
}

export function setupAuthUI(): void {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const logoutBtn = document.getElementById('btnLogout');
  const toggleLoginBtn = document.getElementById('btnToggleLogin');
  const toggleSignUpBtn = document.getElementById('btnSignUp');
  const loginDrawer = document.getElementById('loginDrawer');
  const registerDrawer = document.getElementById('registerDrawer');

  toggleLoginBtn?.addEventListener('click', () => {
    registerDrawer?.classList.remove('open');
    loginDrawer?.classList.toggle('open');
    if (loginDrawer?.classList.contains('open')) {
      (document.getElementById('loginEmail') as HTMLInputElement)?.focus();
    }
  });

  toggleSignUpBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    loginDrawer?.classList.remove('open');
    registerDrawer?.classList.toggle('open');
    if (registerDrawer?.classList.contains('open')) {
      (document.getElementById('regEmail') as HTMLInputElement)?.focus();
    }
  });

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('loginEmail') as HTMLInputElement;
    const passInput = document.getElementById('loginPassword') as HTMLInputElement;
    const btn = document.getElementById('btnLogin') as HTMLButtonElement;
    const errorEl = document.getElementById('loginError');

    btn.disabled = true;
    btn.textContent = 'Logging in...';
    if (errorEl) errorEl.textContent = '';

    try {
      const { success, error } = await doLogin(emailInput.value, passInput.value);
      if (success) {
        btn.disabled = false;
        btn.textContent = 'Login';
        requestRefresh();
      } else {
        if (errorEl) errorEl.textContent = error || 'Login failed';
        btn.disabled = false;
        btn.textContent = 'Login';
      }
    } catch {
      if (errorEl) errorEl.textContent = 'Connection error';
      btn.disabled = false;
      btn.textContent = 'Login';
    }
  });

  registerForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('regEmail') as HTMLInputElement;
    const passInput = document.getElementById('regPassword') as HTMLInputElement;
    const gdprInput = document.getElementById('regGdpr') as HTMLInputElement;
    const btn = document.getElementById('btnRegister') as HTMLButtonElement;
    const errorEl = document.getElementById('registerError');

    if (!gdprInput.checked) {
      if (errorEl) errorEl.textContent = 'Please accept the Privacy Policy';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating account...';
    if (errorEl) errorEl.textContent = '';

    const { success, error } = await doRegister(emailInput.value, passInput.value);

    if (success) {
      requestRefresh();
    } else {
      if (errorEl) errorEl.textContent = error || 'Registration failed';
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  });

  logoutBtn?.addEventListener('click', doLogout);
}

export function renderSyncCta(entries: PendingEntry[], userState: JP343UserState | null): void {
  const section = document.getElementById('syncSection');
  const container = document.getElementById('syncCta');
  if (!container || !section) return;
  container.textContent = '';

  if (userState?.isLoggedIn) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';

  const totalMinutes = entries.reduce((sum, e) => sum + e.duration_min, 0);

  if (entries.length === 0) {
    section.style.display = 'none';
    return;
  }

  if (totalMinutes < 60) {
    const p = document.createElement('p');
    p.textContent = 'Your sessions are saved locally in this browser.';
    container.appendChild(p);
  } else {
    const hours = Math.floor(totalMinutes / 60);
    const hoursText = hours === 1 ? '1 hour' : `${hours} hours`;

    const p = document.createElement('p');
    p.textContent = `${hoursText} tracked locally. Export a backup or create an account to keep your hours safe.`;
    container.appendChild(p);
  }
}

export function renderTierBadge(userState: JP343UserState | null): void {
  const badge = document.getElementById('tierBadge');
  if (!badge) return;

  badge.classList.remove('synced');
  if (userState?.isLoggedIn) {
    badge.textContent = 'Synced';
    badge.classList.add('synced');
  } else {
    badge.textContent = 'Local Only';
  }
}

export async function renderAuthUI(userState: JP343UserState | null): Promise<void> {
  const userBar = document.getElementById('userBar');
  const authToggle = document.getElementById('authToggle');
  const loginDrawer = document.getElementById('loginDrawer');
  const userName = document.getElementById('userName');
  const siteLinks = document.getElementById('siteLinks');

  if (userState?.isLoggedIn) {
    if (userBar) userBar.style.display = 'flex';
    if (authToggle) authToggle.style.display = 'none';
    if (siteLinks) siteLinks.style.display = 'flex';
    if (loginDrawer) { loginDrawer.style.display = 'none'; loginDrawer.classList.remove('open'); }
    const registerDrawer = document.getElementById('registerDrawer');
    if (registerDrawer) { registerDrawer.style.display = 'none'; registerDrawer.classList.remove('open'); }
    const stored = await browser.storage.local.get(STORAGE_KEYS.DISPLAY_NAME);
    if (userName) userName.textContent = stored[STORAGE_KEYS.DISPLAY_NAME] || 'Connected';
  } else {
    if (userBar) userBar.style.display = 'none';
    if (authToggle) authToggle.style.display = '';
    if (siteLinks) siteLinks.style.display = 'none';
    if (loginDrawer) loginDrawer.style.display = '';
  }
}
