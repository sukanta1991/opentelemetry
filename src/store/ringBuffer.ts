// Fixed-capacity ring buffer. Oldest entries are dropped when capacity is exceeded.
export class RingBuffer<T> {
  private items: T[] = [];
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  setCapacity(capacity: number): void {
    this.capacity = Math.max(1, capacity);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  toArray(): T[] {
    return this.items.slice();
  }

  get length(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}
