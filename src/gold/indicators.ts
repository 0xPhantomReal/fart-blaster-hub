export interface Candle {
  time: number; // bar open time, unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Pine ta.ema: seeded with the SMA of the first `len` values. */
export class Ema {
  private seed: number[] = [];
  value: number | null = null;
  constructor(private len: number) {}
  update(x: number): number | null {
    if (this.value === null) {
      this.seed.push(x);
      if (this.seed.length === this.len) this.value = this.seed.reduce((a, b) => a + b, 0) / this.len;
      return this.value;
    }
    const alpha = 2 / (this.len + 1);
    this.value = alpha * x + (1 - alpha) * this.value;
    return this.value;
  }
}

/** Pine ta.rma (Wilder): seeded with the SMA of the first `len` values. */
export class Rma {
  private seed: number[] = [];
  value: number | null = null;
  constructor(private len: number) {}
  update(x: number): number | null {
    if (this.value === null) {
      this.seed.push(x);
      if (this.seed.length === this.len) this.value = this.seed.reduce((a, b) => a + b, 0) / this.len;
      return this.value;
    }
    this.value = (x + (this.len - 1) * this.value) / this.len;
    return this.value;
  }
}
