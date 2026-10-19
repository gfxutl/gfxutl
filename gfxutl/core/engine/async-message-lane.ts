export class AsyncMessageLane<T> {
  private pending: T[] = [];
  private active = 0;
  private activeItems = new Set<T>();

  constructor(
    private readonly handler: (message: T) => void | Promise<void>,
    private readonly concurrency = 1,
  ) {}

  enqueue(message: T) {
    this.pending.push(message);
    this.drain();
  }

  remove(predicate: (message: T) => boolean) {
    const previousLength = this.pending.length;
    this.pending = this.pending.filter((message) => !predicate(message));
    return previousLength - this.pending.length;
  }

  hasActive(predicate: (message: T) => boolean) {
    for (const message of this.activeItems) if (predicate(message)) return true;
    return false;
  }

  private drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const message = this.pending.shift()!;
      this.active++;
      this.activeItems.add(message);
      void Promise.resolve().then(() => this.handler(message))
        .catch(() => undefined)
        .finally(() => {
          this.activeItems.delete(message);
          this.active--;
          this.drain();
        });
    }
  }
}
