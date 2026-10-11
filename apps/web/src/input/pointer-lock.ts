// Mouse-look's pointer lock. Chrome refuses a lock requested within about a second of the user leaving one (Esc), and
// its requestPointerLock() returns a promise that rejects then: the click simply doesn't lock, so the refusal is
// dropped instead of surfacing as an unhandled rejection (Sentry ZOOM3D-WEB-1). Older browsers return nothing.
export function lockPointer(el: { requestPointerLock(): Promise<void> | undefined }): void {
  el.requestPointerLock()?.catch(() => {});
}
