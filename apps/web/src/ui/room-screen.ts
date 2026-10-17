// What the room shows over the view once the player joins: any camera or mic problem, the Cam and Mic buttons, and
// the self-view circle (lobby spec §4).
import type { Call } from '../media/call';
import type { LocalMediaController } from '../media/local-media';
import { joinBanner, PROBLEM_TEXT } from './lobby';
import { showBanner, showMediaControls, showSelfPreview } from './screens';

export interface RoomScreenOptions {
  call: Call;
  local: LocalMediaController;
  name: string;
  avatar: string | null;
}

export function showRoomScreen(ui: HTMLElement, { call, local, name, avatar }: RoomScreenOptions): void {
  const banner = joinBanner(local.state());
  if (banner) {
    showBanner(ui, banner);
  }
  const media = local.state();
  showMediaControls(ui, {
    cam: media.cam,
    mic: media.mic,
    camAvailable: media.camAvailable,
    micAvailable: media.micAvailable,
    async onCam(on) {
      const now = await call.setCam(on);
      showSelfPreview(ui, local.stream, { cam: now, name, avatar });
      const problem = local.state().camProblem;
      if (on && !now && problem) {
        showBanner(ui, PROBLEM_TEXT.cam[problem]);
      }
      return now;
    },
    onMic: (on) => call.setMic(on),
  });
  showSelfPreview(ui, local.stream, { cam: media.cam, name, avatar });
}
