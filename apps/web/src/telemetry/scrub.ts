// A room link is the room's only key: anyone holding it can walk in. Keep it out of error reports.
// Only the room id alphabet (base64url) is matched, so scrubbing serialised JSON never eats a quote or escape.
const ROOM_PATH = /\/r\/[A-Za-z0-9_-]+/g;

export function scrubRoomIds(text: string): string {
  return text.replace(ROOM_PATH, '/r/:room');
}
