/** Bounded snapshots with one refresh per key; stale values remain readable for five minutes. */
export class DashboardCache {
  private readonly entries = new Map<string, { value?: unknown; expiresAt: number; staleUntil: number; pending?: Promise<unknown> }>();
  get(key: string, refresh: boolean, build: () => Promise<unknown>): Promise<unknown> {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (entry?.pending) return !refresh && entry.value !== undefined && now < entry.staleUntil
      ? Promise.resolve(entry.value) : entry.pending;
    if (!refresh && entry?.value !== undefined && now < entry.expiresAt) return Promise.resolve(entry.value);
    if (!entry) {
      for (const [id, cached] of this.entries) if (!cached.pending && cached.staleUntil <= now) this.entries.delete(id);
      if (this.entries.size >= 12) {
        const victim = [...this.entries].find(([, cached]) => !cached.pending);
        if (victim) this.entries.delete(victim[0]);
        else return Promise.reject(new Error('看板正在刷新，请稍后重试'));
      }
      entry = { expiresAt: 0, staleUntil: 0 };
      this.entries.set(key, entry);
    }
    const current = entry;
    const pending = Promise.resolve().then(build).then(value => {
      current.value = value;
      current.expiresAt = Date.now() + 60_000;
      current.staleUntil = Date.now() + 5 * 60_000;
      return value;
    }).finally(() => { current.pending = undefined; });
    current.pending = pending;
    if (!refresh && current.value !== undefined && now < current.staleUntil) {
      void pending.catch(() => {});
      return Promise.resolve(current.value);
    }
    return pending;
  }
}
