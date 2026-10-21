/**
 * WebSocket event-stream tests — the /events endpoint's auth handshake,
 * notification fan-out, control events, and message hygiene.
 */

import { describe, afterAll, beforeAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGateway, type GatewayHandle } from '../../src/gateway.js';
import { createFakeRpc } from './fake-rpc.js';

const TOKEN = 'ws-test-token';

interface WsMessage {
  type: string;
  method?: string;
  params?: unknown;
  event?: string;
}

function connect(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/events`);
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for WS message'));
    }, timeoutMs);
    ws.on('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString('utf8')) as WsMessage);
    });
    ws.on('error', reject);
    ws.on('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`socket closed with ${code} before message`));
    });
  });
}

function nextClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ code: -1, reason: 'timeout' });
    }, timeoutMs);
    ws.on('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

function authenticate(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    });
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8')) as WsMessage;
      if (message.type === 'auth-ok') {
        resolve();
      } else {
        reject(new Error(`unexpected message during auth: ${data.toString('utf8')}`));
      }
    });
    ws.on('error', reject);
  });
}

describe('gateway /events WebSocket', () => {
  let gateway: GatewayHandle;

  beforeAll(async () => {
    gateway = await createGateway({
      port: 0,
      token: TOKEN,
      webDist: null,
      rpc: createFakeRpc(),
      wsAuthTimeoutMs: 300,
      maxWsMessageBytes: 2048,
    });
  });

  afterAll(async () => {
    await gateway.close();
  });

  it('closes unauthenticated sockets after the auth timeout', async () => {
    const ws = connect(gateway.port);
    const close = await nextClose(ws);
    expect(close.code).toBe(4401);
  });

  it('rejects an invalid token immediately', async () => {
    const ws = connect(gateway.port);
    const closePromise = nextClose(ws);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    });
    const close = await closePromise;
    expect(close.code).toBe(4401);
  });

  it('rejects non-auth first messages', async () => {
    const ws = connect(gateway.port);
    const closePromise = nextClose(ws);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'ping' }));
    });
    const close = await closePromise;
    expect(close.code).toBe(4401);
  });

  it('answers authenticated pings with pongs', async () => {
    const ws = connect(gateway.port);
    await authenticate(ws);
    const message = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    await expect(message).resolves.toEqual({ type: 'pong' });
    ws.close();
  });

  it('delivers daemon notifications to authenticated clients', async () => {
    const ws = connect(gateway.port);
    await authenticate(ws);
    const received = nextMessage(ws);
    gateway.broadcastNotification('task.message', { taskId: 'tsk_1', messages: [] });
    await expect(received).resolves.toEqual({
      type: 'notification',
      method: 'task.message',
      params: { taskId: 'tsk_1', messages: [] },
    });
    ws.close();
  });

  it('delivers control events (daemon lifecycle)', async () => {
    const ws = connect(gateway.port);
    await authenticate(ws);
    const received = nextMessage(ws);
    gateway.broadcastControl('daemon:disconnected');
    await expect(received).resolves.toEqual({ type: 'control', event: 'daemon:disconnected' });
    ws.close();
  });

  it('does not deliver notifications to unauthenticated clients', async () => {
    const ws = connect(gateway.port);
    let unexpected: string | null = null;
    ws.on('message', (data) => {
      unexpected = data.toString('utf8');
    });
    gateway.broadcastNotification('task.message', { taskId: 'tsk_1' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(unexpected).toBeNull();
    const close = await nextClose(ws);
    expect(close.code).toBe(4401);
  });

  it('closes sockets that send oversized messages', async () => {
    const ws = connect(gateway.port);
    await authenticate(ws);
    const closePromise = nextClose(ws);
    ws.send('x'.repeat(4096));
    const close = await closePromise;
    expect(close.code).toBe(1009);
  });

  it('closes sockets that send unsupported message types after auth', async () => {
    const ws = connect(gateway.port);
    await authenticate(ws);
    const closePromise = nextClose(ws);
    ws.send(JSON.stringify({ type: 'rpc', method: 'task.list' }));
    const close = await closePromise;
    expect(close.code).toBe(4400);
  });

  it('closes sockets that send binary frames', async () => {
    const ws = connect(gateway.port);
    await authenticate(ws);
    const closePromise = nextClose(ws);
    ws.send(Buffer.from([0, 1, 2]));
    const close = await closePromise;
    expect(close.code).toBe(4400);
  });
});
