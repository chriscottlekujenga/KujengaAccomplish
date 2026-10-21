/**
 * Phase 2 gateway endpoints — native pickers and accomplish:// deep links.
 */

import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import WebSocket from 'ws';
import { createGateway, type GatewayHandle } from '../../src/gateway.js';
import { createFakeRpc } from './fake-rpc.js';

const TOKEN = 'phase2-test-token';

describe('gateway phase 2 endpoints', () => {
  let gateway: GatewayHandle;
  let pickers: { pickFolder: MockInstance; pickFiles: MockInstance };

  beforeAll(async () => {
    pickers = {
      pickFolder: vi.fn(async () => '/home/chris/Documents'),
      pickFiles: vi.fn(async () => [
        {
          id: 'u1',
          name: 'a.md',
          path: '/home/chris/a.md',
          type: 'text',
          size: 3,
          content: 'hi\n',
        },
      ]),
    };
    gateway = await createGateway({
      port: 0,
      token: TOKEN,
      webDist: null,
      rpc: createFakeRpc(),
      pickers: pickers as never,
    });
  });

  afterAll(async () => {
    await gateway.close();
  });

  function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`http://127.0.0.1:${gateway.port}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
      body: JSON.stringify(body),
    });
  }

  it('serves /pick-folder results from the native picker', async () => {
    const res = await post('/pick-folder', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string | null };
    expect(body.path).toBe('/home/chris/Documents');
    expect(pickers.pickFolder).toHaveBeenCalledTimes(1);
  });

  it('serves /pick-files attachment descriptors', async () => {
    const res = await post('/pick-files', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: unknown[] };
    expect(body.files).toHaveLength(1);
    expect(pickers.pickFiles).toHaveBeenCalledTimes(1);
  });

  it('passes picker errors through as JSON-RPC error bodies', async () => {
    pickers.pickFolder.mockImplementationOnce(async () => {
      throw new Error('zenity not available');
    });
    const res = await post('/pick-folder', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('zenity not available');
  });

  it('requires a token for picker endpoints', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/pick-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('accepts accomplish:// callback deep links and broadcasts to WS clients', async () => {
    const res = await post('/deep-link', { url: 'accomplish://callback/mcp?state=42' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
  });

  it('rejects non-callback URLs on /deep-link', async () => {
    for (const url of ['https://evil.example.com', 'accomplish://settings/open']) {
      const res = await post('/deep-link', { url });
      expect(res.status).toBe(400);
    }
  });

  it('requires a token for deep links', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/deep-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'accomplish://callback/mcp' }),
    });
    expect(res.status).toBe(401);
  });

  it('delivers deep-link control events to authenticated WS clients', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/events`);
    const messages: unknown[] = [];
    await new Promise<void>((resolveAuth, rejectAuth) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
      });
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString('utf8')) as { type: string };
        messages.push(JSON.parse(data.toString('utf8')));
        if (message.type === 'auth-ok') {
          resolveAuth();
        }
      });
      ws.on('error', rejectAuth);
    });

    const res = await post('/deep-link', { url: 'accomplish://callback/mcp?state=7' });
    expect(res.status).toBe(200);

    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const control = messages.find(
      (m) =>
        (m as { type?: string; event?: string }).type === 'control' &&
        (m as { event?: string }).event === 'mcp-callback',
    ) as { params?: { url: string } } | undefined;
    expect(control?.params?.url).toBe('accomplish://callback/mcp?state=7');
    ws.close();
  });

  it('records client diagnostics on /client-log', async () => {
    const res = await post('/client-log', { level: 'error', message: 'startup crashed' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recorded: boolean };
    expect(body.recorded).toBe(true);
  });

  it('requires a token for /client-log', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/client-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('serves host-side CLI and autostart status', async () => {
    const statusGateway = await createGateway({
      port: 0,
      token: TOKEN,
      webDist: null,
      rpc: createFakeRpc(),
      cliStatusImpl: async () => ({
        installed: true,
        version: '1.14.18',
        installCommand: 'npm i -g opencode-ai',
      }),
      autostartStatusImpl: () => ({ enabled: true, active: true }),
    });
    const cliRes = await fetch(`http://127.0.0.1:${statusGateway.port}/cli-status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(cliRes.status).toBe(200);
    await expect(cliRes.json()).resolves.toEqual({
      installed: true,
      version: '1.14.18',
      installCommand: 'npm i -g opencode-ai',
    });

    const autoRes = await fetch(`http://127.0.0.1:${statusGateway.port}/autostart-status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    await expect(autoRes.json()).resolves.toEqual({ enabled: true, active: true });
    await statusGateway.close();
  });

  it('scrubs secret-looking fields from provider.getSettings responses', async () => {
    const scrubGateway = await createGateway({
      port: 0,
      token: TOKEN,
      webDist: null,
      rpc: createFakeRpc({
        'provider.getSettings': {
          activeProviderId: 'custom',
          debugMode: false,
          connectedProviders: {
            custom: {
              providerId: 'custom',
              connectionStatus: 'connected',
              selectedModelId: 'custom/glm',
              credentials: {
                type: 'api_key',
                keyPrefix: 'abcd',
                apiKey: 'RAW-KEY-MUST-NOT-LEAVE',
              },
            },
          },
        },
      }),
    });
    const res = await fetch(`http://127.0.0.1:${scrubGateway.port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'provider.getSettings' }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('RAW-KEY-MUST-NOT-LEAVE');
    expect(body).toContain('abcd');
    await scrubGateway.close();
  });
});
