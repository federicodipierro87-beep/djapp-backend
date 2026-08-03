import { createServer, Server as HTTPServer } from 'http';
import type { AddressInfo } from 'net';
import { io as createClient, Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.JWT_SECRET = 'test-secret';

import { generateToken } from '../src/utils/jwt';
import { emitNewRequest, emitToEvent, initializeSocket } from '../src/socket/socket';
import { SOCKET_EVENTS } from '../src/socket/events';

const DJ_ID = 'dj-1';
const EVENT_CODE = 'ABC123';

let httpServer: HTTPServer;
let url: string;
const clients: ClientSocket[] = [];

const connect = (auth?: Record<string, unknown>): Promise<ClientSocket> =>
  new Promise((resolve, reject) => {
    const client = createClient(url, { transports: ['websocket'], auth, forceNew: true });
    clients.push(client);
    client.on('connect', () => resolve(client));
    client.on('connect_error', reject);
  });

const joinEvent = (client: ClientSocket): Promise<void> =>
  new Promise((resolve) => {
    client.emit(SOCKET_EVENTS.JOIN_EVENT, EVENT_CODE);
    // The server acknowledges nothing, so bounce a round trip off it to be sure
    // the join was processed before the test emits anything.
    client.emit('noop');
    setTimeout(resolve, 50);
  });

const nextEvent = (client: ClientSocket, event: string, timeoutMs = 300) =>
  new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    client.once(event, (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

beforeAll(async () => {
  httpServer = createServer();
  initializeSocket(httpServer, ['*']);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clients.forEach((c) => c.disconnect());
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
});

describe('socket authentication', () => {
  it('accepts a guest with no token', async () => {
    const guest = await connect();
    expect(guest.connected).toBe(true);
  });

  it('rejects a token that does not verify', async () => {
    await expect(connect({ token: 'not-a-real-token' })).rejects.toThrow();
  });

  it('rejects a token signed with a different secret', async () => {
    const jwt = await import('jsonwebtoken');
    const forged = jwt.default.sign({ djId: DJ_ID, email: 'a@b.c' }, 'wrong-secret');
    await expect(connect({ token: forged })).rejects.toThrow();
  });
});

describe('room isolation', () => {
  it('keeps new requests out of the public event room', async () => {
    const guest = await connect();
    await joinEvent(guest);

    const dj = await connect({ token: generateToken({ djId: DJ_ID, email: 'dj@example.com' }) });
    await joinEvent(dj);

    const djReceived = nextEvent(dj, SOCKET_EVENTS.NEW_REQUEST);
    const guestReceived = nextEvent(guest, SOCKET_EVENTS.NEW_REQUEST, 200);

    emitNewRequest(DJ_ID, { songTitle: 'Song', donationAmount: 25 });

    await expect(djReceived).resolves.toMatchObject({ donationAmount: 25 });
    await expect(guestReceived).rejects.toThrow(/timeout/);
  });

  it('does not leak a request to a DJ who is not the recipient', async () => {
    const otherDj = await connect({
      token: generateToken({ djId: 'dj-2', email: 'other@example.com' }),
    });

    const received = nextEvent(otherDj, SOCKET_EVENTS.NEW_REQUEST, 200);
    emitNewRequest(DJ_ID, { songTitle: 'Song', donationAmount: 40 });

    await expect(received).rejects.toThrow(/timeout/);
  });

  it('still broadcasts public queue updates to guests', async () => {
    const guest = await connect();
    await joinEvent(guest);

    // Only the delivery matters here: this event carries no payload, and an
    // absent one arrives as null once it has been through JSON.
    const received = nextEvent(guest, SOCKET_EVENTS.QUEUE_UPDATED).then(() => 'delivered');
    emitToEvent(EVENT_CODE, SOCKET_EVENTS.QUEUE_UPDATED);

    await expect(received).resolves.toBe('delivered');
  });
});
