// JP343 Extension - Shared Formatting Utilities
// Genutzt von Popup UND Dashboard

export function formatStatDuration(minutes: number): string {
  const totalSec = Math.round(minutes * 60);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function formatDuration(minutes: number): string {
  const totalSec = Math.round(minutes * 60);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return s > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function isValidImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ISO-Datum als relative Zeitangabe formatieren
export function formatSessionDate(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export function getLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Wochentage Mo-So als ISO-Datums-Strings
export function getWeekDates(): { date: string; label: string; isToday: boolean }[] {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=So, 1=Mo...
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const todayStr = getLocalDateString(now);
  const labels = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

  const days: { date: string; label: string; isToday: boolean }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + mondayOffset + i);
    const dateStr = getLocalDateString(d);
    days.push({ date: dateStr, label: labels[i], isToday: dateStr === todayStr });
  }
  return days;
}
