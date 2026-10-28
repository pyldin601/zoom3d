// The brief notice that the room's portals were flipped (portal doorways spec §2.1).
const NOTICE_MS = 2000;

let hideTimer: ReturnType<typeof setTimeout> | undefined;

/** Says `Portals on` or `Portals off` for 2 s, in place of any notice already showing. */
export function showPortalNotice(ui: HTMLElement, on: boolean): void {
  clearTimeout(hideTimer);
  ui.querySelector(':scope > .portal-notice')?.remove();
  const notice = document.createElement('div');
  notice.className = 'portal-notice';
  notice.textContent = on ? 'Portals on' : 'Portals off';
  ui.append(notice);
  hideTimer = setTimeout(() => notice.remove(), NOTICE_MS);
}
