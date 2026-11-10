// The world objects' sounds: one hum per robot vacuum (robot vacuum spec §5.4), started when it appears and stopped
// when it goes (a server restart brings a new id), its motion read from the interpolated poses; and the ball's kicks
// and bounces (ball spec §6). Events play as they arrive. Parked scooters make no sound.
import { BALL_CRIES, type BallCry, type ObjectEvent, type PlayerState } from '@zoom3d/shared';
import { objectKey, type RemoteObject } from '../net/session';
import { type BallSound, createBallSound } from './ball-sound';
import type { AudioEngine } from './engine';
import { createVacuumSound, motionOf, type VacuumSound } from './vacuum-sound';

export interface ObjectSounds {
  /** Starts sounds for new objects, stops those gone, updates motion from poses (keyed by objectKey). */
  sync(objects: ReadonlyMap<string, RemoteObject>, poses: ReadonlyMap<string, PlayerState>, dtSeconds: number): void;
  /** An event from the server; `by` is a ball's kicker. */
  event(id: string, e: ObjectEvent, by?: string): void;
  /** An event of the ball as this client predicts it: the local player's own kick, and every bounce on screen. */
  localEvent(id: string, e: ObjectEvent): void;
  /** A dribbled ball, as this screen draws it, touched the floor. */
  dribble(id: string): void;
  /** The ball voices one of an emotion's sounds, as the server chose. */
  cry(id: string, cry: BallCry, variant: number): void;
}

type Entry = { kind: 'vacuum'; sound: VacuumSound; last: PlayerState | null } | { kind: 'ball'; sound: BallSound };

export function createObjectSounds(
  ctx: BaseAudioContext,
  engine: AudioEngine,
  selfId: () => string | null = () => null
): ObjectSounds {
  const sounds = new Map<string, Entry>();

  /** A parked scooter is silent: a scooter only sounds while ridden, from its rider (scooter-sounds.ts). */
  const create = (obj: RemoteObject): Entry | null => {
    switch (obj.info.kind) {
      case 'vacuum':
        return { kind: 'vacuum', sound: createVacuumSound(ctx), last: null };
      case 'ball':
        return { kind: 'ball', sound: createBallSound(ctx) };
      case 'scooter':
        return null;
    }
  };

  const playBall = (sound: BallSound, e: ObjectEvent) => {
    if (e === 'kick') {
      sound.kick();
    } else if (e === 'bounce') {
      sound.bounce();
    }
  };

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
        if (!entry) {
          const created = create(obj);
          if (!created) {
            continue;
          }
          entry = created;
          sounds.set(id, entry);
          engine.attachNode(objectKey(id), entry.sound.output);
        }
        const pose = poses.get(objectKey(id));
        if (entry.kind !== 'vacuum' || !pose) {
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

    event(id, e, by) {
      const entry = sounds.get(id);
      if (entry?.kind === 'vacuum') {
        if (e === 'bump') {
          entry.sound.bump();
        } else if (e === 'lost') {
          entry.sound.lost();
        }
      } else if (entry?.kind === 'ball') {
        // The local player's own kick already played when it was made, and the ball on screen is the local one, so
        // its bounces play from there; the server's would double them.
        if (e === 'kick' && (by === undefined || by !== selfId())) {
          entry.sound.kick();
        }
      }
    },

    localEvent(id, e) {
      const entry = sounds.get(id);
      if (entry?.kind === 'ball') {
        playBall(entry.sound, e);
      }
    },

    dribble(id) {
      const entry = sounds.get(id);
      if (entry?.kind === 'ball') {
        entry.sound.dribble();
      }
    },

    cry(id, cry, variant) {
      const entry = sounds.get(id);
      const sound = BALL_CRIES[cry].at(variant);
      if (entry?.kind === 'ball' && sound) {
        entry.sound.cry(sound);
      }
    },
  };
}
