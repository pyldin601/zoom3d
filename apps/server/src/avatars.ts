// People's pictures, kept once per picture and served by `GET /avatar/<id>` instead of riding in every welcome (6d
// spec §3).
import { createHash } from 'node:crypto';

/** Content-addressed: the URL exists only while someone uses the picture, and never says who. */
export function avatarId(dataUrl: string): string {
  return createHash('sha256').update(dataUrl).digest('base64url').slice(0, 22);
}

/** Ref-counted by peers using each picture, in any room. */
export class AvatarStore {
  private readonly entries = new Map<string, { jpeg: Buffer; refs: number }>();

  /** Takes a validated JPEG data URL; returns its id. */
  add(dataUrl: string): string {
    const id = avatarId(dataUrl);
    const entry = this.entries.get(id);
    if (entry) {
      entry.refs++;
    } else {
      this.entries.set(id, { jpeg: Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'), refs: 1 });
    }
    return id;
  }

  release(id: string): void {
    const entry = this.entries.get(id);
    if (entry && --entry.refs === 0) {
      this.entries.delete(id);
    }
  }

  get(id: string): Buffer | null {
    return this.entries.get(id)?.jpeg ?? null;
  }
}
