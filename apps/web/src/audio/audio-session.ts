// iOS Safari mutes Web Audio while the ringer switch is on silent, unless the page declares a call-like audio
// session (mobile spec §6). `navigator.audioSession` exists in Safari 16.4+; elsewhere this does nothing.

export function preferPlayAndRecord(nav: { audioSession?: { type: string } }): void {
  if (nav.audioSession) {
    nav.audioSession.type = 'play-and-record';
  }
}
