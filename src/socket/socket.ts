import { Server as HTTPServer } from 'http';
import { Server, Socket } from 'socket.io';
import { SOCKET_EVENTS } from './events';
import { verifyToken } from '../utils/jwt';

let io: Server | null = null;

const djRoom = (djId: string) => `dj:${djId}`;
const eventRoom = (eventCode: string) => `event:${eventCode}`;

export function initializeSocket(httpServer: HTTPServer, allowedOrigins: string[]): Server {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Guests reach an event by scanning a QR code, so they must be able to connect
  // without credentials. A token is therefore optional, but if one is supplied it
  // has to be valid: that is what grants access to the DJ's private room.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next();

    try {
      socket.data.djId = verifyToken(String(token)).djId;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on(SOCKET_EVENTS.CONNECTION, (socket: Socket) => {
    console.log(`Socket connected: ${socket.id}`);

    const djId: string | undefined = socket.data.djId;
    if (djId) {
      socket.join(djRoom(djId));
    }

    // Join event room. This room is public by design: anyone holding the event
    // code is a guest of that night, so it only ever carries public information.
    socket.on(SOCKET_EVENTS.JOIN_EVENT, (eventCode: string) => {
      if (typeof eventCode === 'string' && eventCode.length > 0 && eventCode.length <= 20) {
        const room = eventRoom(eventCode);
        socket.join(room);
        console.log(`Socket ${socket.id} joined room ${room}`);
      }
    });

    // Leave event room
    socket.on(SOCKET_EVENTS.LEAVE_EVENT, (eventCode: string) => {
      if (typeof eventCode === 'string' && eventCode.length > 0) {
        const room = eventRoom(eventCode);
        socket.leave(room);
        console.log(`Socket ${socket.id} left room ${room}`);
      }
    });

    socket.on(SOCKET_EVENTS.DISCONNECT, () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
}

export function getIO(): Server {
  if (!io) {
    throw new Error('Socket.io not initialized. Call initializeSocket first.');
  }
  return io;
}

// Emit to all clients in an event room
export function emitToEvent(eventCode: string, event: string, data?: unknown): void {
  const socketIO = getIO();
  socketIO.to(eventRoom(eventCode)).emit(event, data);
}

// Incoming requests carry the donation amount, so they go to the DJ's own room
// rather than to the crowd watching the public queue.
export function emitNewRequest(djId: string, request: unknown): void {
  getIO().to(djRoom(djId)).emit(SOCKET_EVENTS.NEW_REQUEST, request);
}

// Emit request accepted event
export function emitRequestAccepted(eventCode: string, request: unknown): void {
  emitToEvent(eventCode, SOCKET_EVENTS.REQUEST_ACCEPTED, request);
}

// Emit request rejected event
export function emitRequestRejected(eventCode: string, requestId: string): void {
  emitToEvent(eventCode, SOCKET_EVENTS.REQUEST_REJECTED, { requestId });
}

// Emit queue updated event
export function emitQueueUpdated(eventCode: string): void {
  emitToEvent(eventCode, SOCKET_EVENTS.QUEUE_UPDATED);
}

// Emit now playing changed event
export function emitNowPlayingChanged(eventCode: string, song: unknown): void {
  emitToEvent(eventCode, SOCKET_EVENTS.NOW_PLAYING_CHANGED, song);
}
