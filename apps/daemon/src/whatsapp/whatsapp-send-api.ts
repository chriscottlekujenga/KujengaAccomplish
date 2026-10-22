/**
 * WhatsApp Send HTTP API — exposes whatsapp.sendMessage to local MCP tools.
 *
 * Follows the same pattern as PermissionService's HTTP servers:
 * - Listens on a well-known port (WHATSAPP_API_PORT = 9230)
 * - Requires Bearer token auth on every request
 * - Returns structured JSON so the MCP tool can relay human-readable errors
 *
 * Route logic lives in whatsapp-routes.ts; this file owns only lifecycle.
 */
import http from 'node:http';
import { createHttpServer } from '../http-server-factory.js';
import { RateLimiter } from '../rate-limiter.js';
import type { WhatsAppDaemonService } from '../whatsapp-service.js';
import { buildChatsRoute, buildMessagesRoute, buildSendRoute } from './whatsapp-routes.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;

export class WhatsAppSendApi {
  private whatsappService: WhatsAppDaemonService;
  private authToken: string;
  private server: http.Server | null = null;
  private port: number | null = null;
  private rateLimiter = new RateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS);

  constructor(whatsappService: WhatsAppDaemonService, authToken: string) {
    this.whatsappService = whatsappService;
    this.authToken = authToken;
  }

  async start(fixedPort?: number): Promise<void> {
    const { server, port } = await createHttpServer({
      authToken: this.authToken,
      rateLimiter: this.rateLimiter,
      serviceName: 'WhatsAppSendApi',
      port: fixedPort,
      routes: [
        buildChatsRoute(this.whatsappService),
        buildMessagesRoute(this.whatsappService),
        buildSendRoute(this.whatsappService),
      ],
    });

    this.server = server;
    this.port = port;
  }

  getPort(): number | null {
    return this.port;
  }

  /**
   * Loopback-bind verification for tests (Phase 3 M1 §5.3) — the listening
   * address as reported by the OS ('127.0.0.1' when loopback-bound).
   */
  getBindAddress(): string | null {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.address : null;
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = null;
    }
  }
}
