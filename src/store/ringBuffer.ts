// Fixed-capacity ring buffer. Oldest entries are dropped when capacity is exceeded.
// A capacity <= 0 means unbounded (used by imported instances, which never grow).
export class RingBuffer<T> {
  private items: T[] = [];
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = normalizeCapacity(capacity);
  }

  push(item: T): void {
    this.items.push(item);
    this.trim();
  }

  setCapacity(capacity: number): void {
    this.capacity = normalizeCapacity(capacity);
    this.trim();
  }

  private trim(): void {
    if (this.capacity === Infinity) return;
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  toArray(): T[] {
    return this.items.slice();
  }

  // Live view for read-only hot paths; callers must not mutate the result.
  view(): readonly T[] {
    return this.items;
  }

  last(): T | undefined {
    return this.items.length ? this.items[this.items.length - 1] : undefined;
  }

  get length(): number {
    return this.items.length;
  }

  get isUnbounded(): boolean {
    return this.capacity === Infinity;
  }

  clear(): void {
    this.items = [];
  }
}

function normalizeCapacity(capacity: number): number {
  if (!Number.isFinite(capacity) || capacity <= 0) return Infinity;
  return Math.max(1, capacity);
}
