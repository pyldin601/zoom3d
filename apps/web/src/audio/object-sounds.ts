// One hum per world object (robot vacuum spec §5.4): started when an object appears, stopped when it goes (a server
// restart brings a new id), its motion read from the interpolated poses and its events played as they arrive.
import type { ObjectEvent, PlayerState } from '@zoom3d/shared';
import { objectKey, type RemoteObject } from '../net/session';
import type { AudioEngine } from './engine';
import { createVacuumSound, motionOf, type VacuumSound } from './vacuum-sound';

export interface ObjectSounds {
  /** Starts sounds for new objects, stops those gone, updates motion from poses (keyed by objectKey). */
  sync(objects: ReadonlyMap<string, RemoteObject>, poses: ReadonlyMap<string, PlayerState>, dtSeconds: number): void;
  event(id: string, e: ObjectEvent): void;
}

export function createObjectSounds(ctx: BaseAudioContext, engine: AudioEngine): ObjectSounds {
  const sounds = new Map<string, { sound: VacuumSound; last: PlayerState | null }>();

  return {
    sync(objects, poses, dtSeconds) {
      for (const [id, entry] of sounds) {
        if (!objects.has(id)) {
          engine.detach(objectKey(id));
          entry.sound.dispose();
          sounds.delete(id);
        }
      }
      for (const [id, obj] of objects) {
        let entry = sounds.get(id);
        if (!entry && obj.info.kind === 'vacuum') {
          entry = { sound: createVacuumSound(ctx), last: null };
          sounds.set(id, entry);
          engine.attachNode(objectKey(id), entry.sound.output);
        }
        const pose = poses.get(objectKey(id));
        if (!entry || !pose) {
          continue;
        }
        if (entry.last) {
          entry.sound.setMotion(motionOf(entry.last, pose, dtSeconds));
          Object.assign(entry.last, pose);
        } else {
          entry.last = { ...pose };
        }
      }
    },

    event(id, e) {
      const sound = sounds.get(id)?.sound;
      if (e === 'bump') {
        sound?.bump();
      } else {
        sound?.lost();
      }
    },
  };
}
