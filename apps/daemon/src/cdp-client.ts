/**
 * CdpClient — minimal WebSocket Chrome DevTools Protocol client for the
 * daemon (Phase 3 M2 T4, browser-preview on-demand screenshot v1).
 *
 * Ported from the desktop's services/cdp-client.ts (ENG-695) minus the event
 * plumbing: the on-demand flow only ISSUES commands (Target.attachToTarget,
 * Page.getLayoutMetrics, Page.captureScreenshot) — there is no live
 * screencast, so nothing subscribes to CDP events.
 *
 * Runs on the Node global `WebSocket` (stable since Node 22; the monorepo
 * pins engines node >= 24) — no new dependency.
 */

const COMMAND_TIMEOUT_MS = 10_000;

interface CdpCommandResponse {
  id: number;
  result?: unknown;
  error?: { message?: string };
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();

  async connect(endpoint: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const ws = new WebSocket(endpoint);

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error(`Failed to connect to CDP endpoint: ${endpoint}`));
      };
      const cleanup = () => {
        ws.removeEventListener('open', handleOpen);
        ws.removeEventListener('error', handleError);
      };

      ws.addEventListener('open', handleOpen);
      ws.addEventListener('error', handleError);
    });

    ws.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });
    ws.addEventListener('close', () => {
      this.rejectAllPending(new Error('CDP websocket closed'));
    });
    ws.addEventListener('error', () => {
      this.rejectAllPending(new Error('CDP websocket error'));
    });

    this.ws = ws;
  }

  async sendCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP websocket is not connected');
    }

    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method };
    if (params) payload.params = params;
    if (sessionId) payload.sessionId = sessionId;

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timeout });
      this.ws?.send(JSON.stringify(payload));
    });
  }

  async disconnect(): Promise<void> {
    this.rejectAllPending(new Error('CDP disconnected'));
    if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
      this.ws.close();
    }
    this.ws = null;
  }

  private handleMessage(rawData: unknown): void {
    const raw = typeof rawData === 'string' ? rawData : this.toText(rawData);
    if (!raw) {
      return;
    }

    let message: CdpCommandResponse;
    try {
      message = JSON.parse(raw) as CdpCommandResponse;
    } catch {
      return;
    }

    if (typeof message.id !== 'number') {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error?.message) {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  private toText(rawData: unknown): string | null {
    if (rawData instanceof ArrayBuffer) {
      return Buffer.from(rawData).toString('utf8');
    }
    if (ArrayBuffer.isView(rawData)) {
      return Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength).toString('utf8');
    }
    if (typeof Blob !== 'undefined' && rawData instanceof Blob) {
      // Blob.text() is async and cannot be awaited synchronously here; the
      // on-demand flow only string frames over text frames, so bail.
      return null;
    }
    return null;
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
