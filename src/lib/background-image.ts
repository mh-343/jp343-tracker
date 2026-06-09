import { STORAGE_KEYS } from '../types';

const DB_NAME = 'jp343-assets';
const STORE_NAME = 'backgrounds';
const BG_KEY = 'dashboard-background';

let currentObjectUrl: string | null = null;
let cachedBlob: Blob | null = null;
let loadGeneration = 0;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function bumpRevision(): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.BG_IMAGE_REVISION]: Date.now() });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(',');
  const header = commaIdx >= 0 ? dataUrl.slice(0, commaIdx) : '';
  const data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const mime = header.match(/data:([^;]+)/)?.[1] ?? 'image/jpeg';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

export async function saveBackground(blob: Blob): Promise<void> {
  cachedBlob = blob;
  const reader = new FileReader();
  const base64 = await new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  await browser.storage.local.set({ [STORAGE_KEYS.BACKGROUND_IMAGE]: base64 });
  await bumpRevision();
}

export async function loadBackground(): Promise<Blob | null> {
  try {
    const db = await openDB();
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(BG_KEY);
      req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
    if (blob) {
      try {
        const existing = await browser.storage.local.get(STORAGE_KEYS.BACKGROUND_IMAGE);
        if (!existing[STORAGE_KEYS.BACKGROUND_IMAGE]) {
          const reader = new FileReader();
          const base64 = await new Promise<string>((resolve, reject) => {
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          await browser.storage.local.set({ [STORAGE_KEYS.BACKGROUND_IMAGE]: base64 });
        }
      } catch { /* backfill failure is non-critical */ }
      return blob;
    }
  } catch {
    /* ignore */
  }

  const result = await browser.storage.local.get(STORAGE_KEYS.BACKGROUND_IMAGE);
  const base64 = result[STORAGE_KEYS.BACKGROUND_IMAGE] as string | undefined;
  if (!base64) return null;

  return dataUrlToBlob(base64);
}

export async function removeBackground(): Promise<void> {
  cachedBlob = null;
  await browser.storage.local.remove(STORAGE_KEYS.BACKGROUND_IMAGE);
  await bumpRevision();
}

export function clearBackgroundDom(): void {
  const layer = document.querySelector('.bg-layer');
  const overlay = document.querySelector('.bg-overlay');
  if (layer) layer.remove();
  if (overlay) overlay.remove();
  document.body.classList.remove('has-bg');
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

export function resizeImage(file: File, maxW = 1920, maxH = 1080, quality = 0.80): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width;
      let h = img.height;

      if (w > maxW || h > maxH) {
        const ratio = Math.min(maxW / w, maxH / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(img.src);
          if (blob) resolve(blob);
          else reject(new Error('Canvas toBlob failed'));
        },
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error('Image load failed'));
    };
    img.src = URL.createObjectURL(file);
  });
}

export async function applyDashboardBackground(enabled: boolean, opacity: number): Promise<void> {
  const thisGeneration = ++loadGeneration;
  const existingLayer = document.querySelector('.bg-layer') as HTMLElement | null;
  const existingOverlay = document.querySelector('.bg-overlay') as HTMLElement | null;

  if (!enabled) {
    clearBackgroundDom();
    return;
  }

  if (existingLayer && currentObjectUrl) {
    if (existingOverlay) existingOverlay.style.opacity = String(opacity / 100);
    return;
  }

  const blob = cachedBlob ?? await loadBackground();
  if (thisGeneration !== loadGeneration) return;
  if (!blob) {
    clearBackgroundDom();
    const result = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
    const settings = result[STORAGE_KEYS.SETTINGS];
    if (settings?.backgroundEnabled) {
      await browser.storage.local.set({
        [STORAGE_KEYS.SETTINGS]: { ...settings, backgroundEnabled: false }
      });
    }
    return;
  }

  cachedBlob = blob;

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }
  currentObjectUrl = URL.createObjectURL(blob);

  if (existingLayer) {
    existingLayer.style.backgroundImage = `url(${currentObjectUrl})`;
    if (existingOverlay) existingOverlay.style.opacity = String(opacity / 100);
  } else {
    const layer = document.createElement('div');
    layer.className = 'bg-layer';
    layer.style.backgroundImage = `url(${currentObjectUrl})`;

    const overlay = document.createElement('div');
    overlay.className = 'bg-overlay';
    overlay.style.opacity = String(opacity / 100);

    document.body.prepend(overlay);
    document.body.prepend(layer);
  }

  document.body.classList.add('has-bg');
}
