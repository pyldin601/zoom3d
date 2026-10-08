// Fixed-capacity ring buffer of timestamped poses, sampled with linear interpolation.

export interface Snapshot {
  t: number;
  x: number;
  y: number;
  angle: number;
}

const TWO_PI = Math.PI * 2;

export class SnapshotBuffer {
  private readonly items: Snapshot[] = [];
  private start = 0;

  constructor(private readonly capacity = 32) {}

  private at(i: number): Snapshot {
    return this.items[(this.start + i) % this.items.length] as Snapshot;
  }

  latest(): Snapshot | null {
    return this.items.length === 0 ? null : this.at(this.items.length - 1);
  }

  push(s: Snapshot): void {
    const last = this.latest();
    if (last && s.t < last.t) return;
    if (last && s.t === last.t) {
      Object.assign(last, s);
      return;
    }
    if (this.items.length < this.capacity) {
      this.items.push({ ...s });
    } else {
      this.items[this.start] = { ...s };
      this.start = (this.start + 1) % this.capacity;
    }
  }

  sample(t: number, out: { x: number; y: number; angle: number }): boolean {
    const n = this.items.length;
    if (n === 0) return false;
    let a = this.at(0);
    let b = a;
    if (t >= this.at(n - 1).t) {
      a = b = this.at(n - 1);
    } else if (t > a.t) {
      for (let i = 1; i < n; i++) {
        b = this.at(i);
        if (b.t >= t) break;
        a = b;
      }
    }
    const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
    let turn = (b.angle - a.angle) % TWO_PI;
    if (turn > Math.PI) turn -= TWO_PI;
    if (turn < -Math.PI) turn += TWO_PI;
    let angle = (a.angle + turn * k) % TWO_PI;
    if (angle < 0) angle += TWO_PI;
    out.x = a.x + (b.x - a.x) * k;
    out.y = a.y + (b.y - a.y) * k;
    out.angle = angle;
    return true;
  }
}
