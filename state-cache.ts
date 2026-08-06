/**
 * A short-lived, process-local read cache. Values never escape by reference, and a
 * generation check prevents an older asynchronous read from overwriting a newer write.
 * Disk remains authoritative once the monotonic TTL expires.
 */
export class WorkflowStateCache<T extends { id: string }> {
  private readonly entries = new Map<string, { value: T | undefined; expiresAt: number; generation: number }>();
  private listEntry: { value: T[]; expiresAt: number; generation: number } | undefined;
  private listGeneration = 0;
  private epoch = 0;

  constructor(private readonly ttlMs = 250, private readonly now: () => number = () => performance.now()) {}

  private clone<V>(value: V): V { return structuredClone(value); }
  private fresh(expiresAt: number): boolean { return expiresAt > this.now(); }

  async get(id: string, load: (id: string) => Promise<T | undefined>): Promise<T | undefined> {
    const cached = this.entries.get(id);
    if (cached && this.fresh(cached.expiresAt)) return cached.value === undefined ? undefined : this.clone(cached.value);
    const generation = cached?.generation ?? 0;
    const epoch = this.epoch;
    const value = await load(id);
    // Do not let a read begun before set/delete/clear restore stale data.
    if (this.epoch === epoch && (this.entries.get(id)?.generation ?? 0) === generation) {
      this.entries.set(id, { value: value === undefined ? undefined : this.clone(value), expiresAt: this.now() + this.ttlMs, generation: generation + 1 });
    }
    return value === undefined ? undefined : this.clone(value);
  }

  async list(load: () => Promise<T[]>): Promise<T[]> {
    if (this.listEntry && this.fresh(this.listEntry.expiresAt)) return this.clone(this.listEntry.value);
    const generation = this.listGeneration;
    const epoch = this.epoch;
    const entryGenerations = new Map([...this.entries].map(([id, entry]) => [id, entry.generation]));
    const values = await load();
    if (this.epoch === epoch && this.listGeneration === generation) {
      const copy = this.clone(values);
      // Claim this list generation. A second list begun concurrently must not
      // overwrite the first completed list with an older late result.
      this.listGeneration = generation + 1;
      this.listEntry = { value: copy, expiresAt: this.now() + this.ttlMs, generation: this.listGeneration };
      for (const value of copy) {
        const entry = this.entries.get(value.id);
        const capturedGeneration = entryGenerations.get(value.id) ?? 0;
        if ((entry?.generation ?? 0) === capturedGeneration) this.entries.set(value.id, { value: this.clone(value), expiresAt: this.now() + this.ttlMs, generation: capturedGeneration + 1 });
      }
    }
    return this.clone(values);
  }

  set(value: T): void {
    const previous = this.entries.get(value.id);
    this.entries.set(value.id, { value: this.clone(value), expiresAt: this.now() + this.ttlMs, generation: (previous?.generation ?? 0) + 1 });
    this.invalidateList();
  }

  delete(id: string): void {
    const previous = this.entries.get(id);
    this.entries.set(id, { value: undefined, expiresAt: this.now() + this.ttlMs, generation: (previous?.generation ?? 0) + 1 });
    this.invalidateList();
  }

  clear(): void { this.entries.clear(); this.listEntry = undefined; this.listGeneration++; this.epoch++; }
  private invalidateList(): void { this.listEntry = undefined; this.listGeneration++; }
}
