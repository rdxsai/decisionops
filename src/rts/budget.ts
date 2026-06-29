export class SearchBudget {
  private used = 0;
  constructor(private readonly max: number) {}
  tryConsume(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
  spent(): number { return this.used; }
  remaining(): number { return Math.max(0, this.max - this.used); }
}
