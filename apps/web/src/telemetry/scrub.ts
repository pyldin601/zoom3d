// A room link is the room's only key: anyone holding it can walk in. Keep it out of error reports.
// Only the room id alphabet (base64url) is matched, so scrubbing serialised JSON never eats a quote or escape.
const ROOM_PATH = /\/r\/[A-Za-z0-9_-]+/g;

export function scrubRoomIds(text: string): string {
  return text.replace(ROOM_PATH, '/r/:room');
}

// A LiveKit access token is a join credential and carries the room in its payload: never report one. livekit-client
// puts it in URLs (`?access_token=`), so it shows up in breadcrumbs; any JWT-shaped string goes too.
const TOKEN_PARAM = /(access_token=)[^&"\s]+/g;
const JWT = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Room ids and access tokens out of text bound for error reports (safe on serialised JSON). */
export function scrubTelemetry(text: string): string {
  return scrubRoomIds(text).replace(TOKEN_PARAM, '$1:token').replace(JWT, ':token');
}
