// Guests join the room named after the code they scanned. For anything created
// through the Event system that is the Event's own code, and only accounts old
// enough to predate it fall back to the DJ's permanent code.
//
// Every emit used to name the DJ's code unconditionally, so for a modern event
// the server was shouting into a room nobody was in: the public queue screens
// simply never updated.
export function broadcastCode(source: {
  event?: { eventCode: string } | null;
  dj?: { eventCode: string } | null;
}): string | null {
  return source.event?.eventCode ?? source.dj?.eventCode ?? null;
}
