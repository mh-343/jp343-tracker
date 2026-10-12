export interface GsmDbIdentity {
  dbId: string;
  knownGameUuids: string[];
  changed: boolean;
}

export function newGsmDbId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), n => n.toString(16).padStart(2, '0')).join('');
}

// null: GSM has no games, so nothing may be synced
export function resolveGsmDbIdentity(
  dbId: string | null,
  knownGameUuids: string[],
  gameUuids: string[],
  createId: () => string = newGsmDbId
): GsmDbIdentity | null {
  if (!gameUuids.length) return null;
  const current = [...new Set(gameUuids)].sort();
  const known = new Set(knownGameUuids);
  const sameDatabase = !!dbId && current.some(uuid => known.has(uuid));
  return { dbId: sameDatabase && dbId ? dbId : createId(), knownGameUuids: current, changed: !sameDatabase };
}
