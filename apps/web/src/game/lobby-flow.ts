// The lobby (lobby spec §4.5): the camera, the mic and an AudioContext, opened for the lobby's preview and meter, then
// handed to the room on Join.
import { preferPlayAndRecord } from '../audio/audio-session';
import { loadAvatar } from '../media/avatar';
import { createFramer } from '../media/framer';
import { createFramingMemory } from '../media/framing-memory';
import { createLocalMedia, type LocalMediaController } from '../media/local-media';
import { loadMediaPrefs, saveMediaPrefs } from '../media/media-prefs';
import { createOwnGlowSampler } from '../media/own-glow';
import { track } from '../telemetry/analytics';
import { mediaOutcome } from '../telemetry/onboarding';
import { showLobby } from '../ui/lobby';
import { createMicLevel } from '../ui/mic-level';
import { loadName } from '../ui/name-store';
import { type PageElements, pageStorage } from './page';
import type { You } from './you';

export interface LobbyJoin {
  name: string;
  avatar: string | null;
  local: LocalMediaController;
  audioCtx: AudioContext;
}

export interface LobbyOptions {
  page: PageElements;
  you: You;
  /** The host is whoever started the party in this page; anyone else came by a link. */
  entry: 'host' | 'invite';
  onJoin(join: LobbyJoin): void;
}

export function openLobby(o: LobbyOptions): void {
  const audioCtx = openAudio();
  const local = openLocalMedia(o.page);
  shareYourCameraColour(local, o.you);
  track({ name: 'lobby_viewed', entry: o.entry });
  void local.ready.then(() => track({ name: 'media_permission', ...mediaOutcome(local.state()) }));
  // Saved for the whole visit, so the room's Cam/Mic buttons are remembered too.
  local.subscribe(() => saveMediaPrefs(pageStorage(), local.prefs()));
  const meter = createMicLevel(audioCtx);
  meter.setTrack(local.micTrack());
  const stopMetering = local.subscribe(() => meter.setTrack(local.micTrack()));
  const closeLobby = showLobby(o.page.ui, {
    media: local,
    defaultName: loadName(pageStorage()),
    defaultAvatar: loadAvatar(pageStorage()),
    level: meter.level,
    inviteUrl: location.href,
    onJoin(name, avatar) {
      // Resumed synchronously inside the Join click (user gesture), before anything else.
      void audioCtx.resume();
      closeLobby();
      stopMetering();
      meter.dispose();
      o.onJoin({ name, avatar, local, audioCtx });
    },
  });
}

/** Made now for the mic meter; a browser that keeps it suspended lets it start on the first click or key. */
function openAudio(): AudioContext {
  // Before any capture: on iOS this keeps voices audible with the ringer switch on silent (mobile spec §6).
  preferPlayAndRecord(navigator as { audioSession?: { type: string } });
  const audioCtx = new AudioContext({ latencyHint: 'interactive' });
  const resume = () => void audioCtx.resume();
  window.addEventListener('pointerdown', resume, { once: true });
  window.addEventListener('keydown', resume, { once: true });
  return audioCtx;
}

function openLocalMedia(page: PageElements): LocalMediaController {
  return createLocalMedia(
    {
      isSecureContext: window.isSecureContext,
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
      onDeviceChange: (cb) => navigator.mediaDevices?.addEventListener('devicechange', cb),
      framer: createFramer({ container: page.localMedia, document, memory: createFramingMemory(pageStorage()) }),
    },
    loadMediaPrefs(pageStorage())
  );
}

/** Your face glows in your camera's colour while the camera is on. */
function shareYourCameraColour(local: LocalMediaController, you: You): void {
  const ownFace = createOwnGlowSampler(local.framer.canvas, document);
  // Kept from the controller's notifications (every camera change notifies), not asked of it every frame.
  let camOn = local.state().cam;
  local.subscribe(() => {
    camOn = local.state().cam;
  });
  you.useCameraColour((now) => (camOn ? ownFace.colour(now) : null));
}
