let storageLock: Promise<void> = Promise.resolve();

export function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = storageLock.then(() => fn());
  storageLock = p.then(() => {}, () => {});
  return p;
}
