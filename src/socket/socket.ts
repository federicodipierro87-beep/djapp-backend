import { Server as HTTPServer } from 'http';
import { Server, Socket } from 'socket.io';
import { SOCKET_EVENTS } from './events';

let io: Server | null = null;

export function initializeSocket(httpServer: HTTPServer, allowedOrigins: string[]): Server {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on(SOCKET_EVENTS.CONNECTION, (socket: Socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Join event room
    socket.on(SOCKET_EVENTS.JOIN_EVENT, (eventCode: string) => {
      if (eventCode) {
        const room = `event:${eventCode}`;
        socket.join(room);
        console.log(`Socket ${socket.id} joined room ${room}`);
      }
    });

    // Leave event room
    socket.on(SOCKET_EVENTS.LEAVE_EVENT, (eventCode: string) => {
      if (eventCode) {
        const room = `event:${eventCode}`;
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
  const room = `event:${eventCode}`;
  socketIO.to(room).emit(event, data);
}

// Emit new request event
export function emitNewRequest(eventCode: string, request: unknown): void {
  emitToEvent(eventCode, SOCKET_EVENTS.NEW_REQUEST, request);
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
