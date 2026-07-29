// Socket.io event constants
export const SOCKET_EVENTS = {
  // Connection events
  CONNECTION: 'connection',
  DISCONNECT: 'disconnect',

  // Room events
  JOIN_EVENT: 'join-event',
  LEAVE_EVENT: 'leave-event',

  // Request events
  NEW_REQUEST: 'new-request',
  REQUEST_ACCEPTED: 'request-accepted',
  REQUEST_REJECTED: 'request-rejected',

  // Queue events
  QUEUE_UPDATED: 'queue-updated',
  NOW_PLAYING_CHANGED: 'now-playing-changed',
} as const;

export type SocketEventType = typeof SOCKET_EVENTS[keyof typeof SOCKET_EVENTS];
