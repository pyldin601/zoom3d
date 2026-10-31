// Who lights or puts away a lighter, heard (lighter spec §3.5): a peer's lighter from where they stand, through the
// voice path like the ball; the local player's own unplaced, as it is in their hand.
import type { HeldItem } from '@zoom3d/shared';
import type { AudioEngine } from './engine';
import { createLighterSound, type LighterSound } from './lighter-sound';

export interface LighterSounds {
  /** A peer's hand changed from `before` to `after`. */
  peerHeld(id: string, before: HeldItem | null, after: HeldItem | null): void;
  peerLeft(id: string): void;
  /** The local player's hand changed from `before` to `after`. */
  own(before: HeldItem | null, after: HeldItem | null): void;
}

const lighterKey = (peerId: string) => `lighter:${peerId}`;

export function createLighterSounds(ctx: BaseAudioContext, engine: AudioEngine): LighterSounds {
  const peers = new Map<string, LighterSound>();
  let ownSound: LighterSound | null = null;

  const peerSound = (id: string) => {
    let sound = peers.get(id);
    if (!sound) {
      sound = createLighterSound(ctx);
      peers.set(id, sound);
      engine.attachNode(lighterKey(id), sound.output, id);
    }
    return sound;
  };

  return {
    peerHeld(id, before, after) {
      if (after === 'lighter' && before !== 'lighter') {
        peerSound(id).on();
      } else if (before === 'lighter' && after !== 'lighter') {
        peerSound(id).off();
      }
    },
    peerLeft(id) {
      const sound = peers.get(id);
      if (sound) {
        engine.detach(lighterKey(id));
        sound.dispose();
        peers.delete(id);
      }
    },
    own(before, after) {
      if ((after === 'lighter') === (before === 'lighter')) {
        return;
      }
      if (!ownSound) {
        ownSound = createLighterSound(ctx);
        engine.playUnplaced(ownSound.output);
      }
      if (after === 'lighter') {
        ownSound.on();
      } else {
        ownSound.off();
      }
    },
  };
}
