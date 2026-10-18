export class AsyncMessageLane<T> {
  private pending: T[] = [];
  private active = 0;

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

  private drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const message = this.pending.shift()!;
      this.active++;
      void Promise.resolve().then(() => this.handler(message))
        .catch(() => undefined)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }
}
