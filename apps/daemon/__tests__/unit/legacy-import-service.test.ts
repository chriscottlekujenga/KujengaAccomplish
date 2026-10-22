import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'better-sqlite3';
import { createStorage } from '@accomplish_ai/agent-core';
import { LegacyImportService } from '../../src/legacy-import-service.js';
import { SecretsService } from '../../src/secrets-service.js';

/**
 * Milestone 2 — LegacyImportService reads electron-store JSON files DIRECTLY
 * (no `electron-store` dep) and applies the same SQL the desktop helper used.
 *
 * We stub `better-sqlite3`'s Database surface at the prepared-statement
 * level: each `db.prepare(sql)` returns a canned statement object whose
 * `.get()` / `.run()` / `.all()` we can assert against. Real SQL is covered
 * by agent-core integration tests — here we only care about:
 *
 *   1. Flag-based idempotency (already-imported, existing-data).
 *   2. Correct JSON parsing from the provided paths (missing file = empty).
 *   3. Each import stage fires the right prepared statement with the right
 *      row arguments.
 *   4. `schema_meta` completion flag is set on every happy-path return.
 *
 * Phase 3 M2 T5 — audit root fix (checkpoint §18.3.1): the
 * `connectedProviders[*].credentials` blob is now ROUTED into the daemon's
 * real secure-storage backend (a real `SecretsService` over a real
 * encrypted file in the per-test tmp dir — plaintext read-back assertions,
 * permitted inside the daemon suite) and STRIPPED from the persisted blob
 * (substring + deep key-name absence checks, plus a `settings.getAll`-shape
 * simulation of the parse the provider repository performs). Fixture shapes
 * exercise the audited `apiKey` variant, bedrock/vertex credential
 * documents, null/empty entries, and a live-key clobber guard.
 */
type RunResult = { changes: number };

function makeStmt(opts?: { get?: unknown; run?: RunResult; all?: unknown[] }) {
  return {
    get: vi.fn(() => opts?.get),
    run: vi.fn(() => opts?.run ?? { changes: 0 }),
    all: vi.fn(() => opts?.all ?? []),
  };
}

type StmtMock = ReturnType<typeof makeStmt>;

function makeDbStub(sqlToStmt: Map<string, StmtMock>): Database {
  return {
    prepare: vi.fn((sql: string) => {
      const key = sql.trim().replace(/\s+/g, ' ');
      const stmt = sqlToStmt.get(key);
      if (stmt) {
        return stmt;
      }
      // Unknown SQL — return a stub that records the SQL text for debugging
      const fallback = makeStmt();
      sqlToStmt.set(key, fallback);
      return fallback;
    }),
  } as unknown as Database;
}

// SQL text keys (trimmed + single-spaced) used by the service. Keeping these
// as constants makes it easy to spot when the service's SQL drifts from
// what the test expects.
const SCHEMA_META_SELECT = 'SELECT value FROM schema_meta WHERE key = ?';
const APP_SETTINGS_SELECT = 'SELECT onboarding_complete FROM app_settings WHERE id = 1';
const PROVIDER_COUNT_SELECT = 'SELECT COUNT(*) as count FROM providers';
const TASK_COUNT_SELECT = 'SELECT COUNT(*) as count FROM tasks';
const SCHEMA_META_UPSERT = 'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)';
const APP_SETTINGS_UPDATE =
  'UPDATE app_settings SET debug_mode = ?, onboarding_complete = ?, selected_model = ?, ollama_config = ?, litellm_config = ? WHERE id = 1';
const PROVIDER_META_UPDATE =
  'UPDATE provider_meta SET active_provider_id = ?, debug_mode = ? WHERE id = 1';

/** Secret material used in fixtures — NEVER persisted into the settings blob. */
const PLAINTEXTS = {
  anthropic: 'sk-ant-LIVE-0123456789abcdef',
  custom: 'sk-custom-LIVE-0123456789abcdef',
  nested: 'sk-nested-LIVE-0123456789abcdef',
  bedrockAccessKeyId: 'AKIALIVEID012345',
  bedrockSecretKey: 'wJalLIVE-secret-0123456789abcdef',
  bedrockSessionToken: 'st-LIVE-0123456789abcdef',
  bedrockApiKey: 'bb_LIVE_KEY-0123456789abcdef',
  serviceAccountPrivateKey: 'PEM-LIVE-BLOCK-0123456789abcdef',
  rawVariant: 'sk-raw-variant-LIVE-0123456789abcdef',
};

let sinkFileCounter = 0;

/**
 * Real daemon-side SecretsService over a real encrypted secure-storage file
 * in the per-test tmp dir — the same backend live provider keys use. Spies
 * wrap (not replace) the real methods, so read-back proofs exercise the
 * actual AES-256-GCM round-trip.
 */
function makeSecretSink(dir: string) {
  sinkFileCounter++;
  const storageApi = createStorage({
    userDataPath: dir,
    secureStorageFileName: `secure-storage-import-test-${sinkFileCounter}.json`,
  });
  const secrets = new SecretsService(storageApi);
  return {
    secrets,
    storeSpy: vi.spyOn(secrets, 'storeApiKey'),
    bedrockSpy: vi.spyOn(secrets, 'storeBedrockCredentials'),
  };
}

/** Every object key at any nesting depth. */
function collectKeysDeep(value: unknown, found: string[] = [], depth = 0): string[] {
  if (depth > 32) {
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeysDeep(item, found, depth + 1);
    }
    return found;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      found.push(key);
      collectKeysDeep(entry, found, depth + 1);
    }
  }
  return found;
}

/**
 * Replicates the provider-repository parse that feeds `settings.getAll` /
 * `provider.getSettings`: the persisted `credentials_data` JSON becomes the
 * `credentials` field of the served `ConnectedProvider`.
 */
function credentialsServedBySettings(blobJson: unknown): unknown {
  return JSON.parse(blobJson as string);
}

describe('LegacyImportService', () => {
  let tmpDir: string;
  let appSettingsPath: string;
  let providerSettingsPath: string;
  let taskHistoryPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-import-'));
    appSettingsPath = path.join(tmpDir, 'app-settings.json');
    providerSettingsPath = path.join(tmpDir, 'provider-settings.json');
    taskHistoryPath = path.join(tmpDir, 'task-history.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function pathsInput() {
    return { appSettingsPath, providerSettingsPath, taskHistoryPath };
  }

  it('returns already-imported when schema_meta flag is set, without touching JSON', () => {
    const stmts = new Map<string, StmtMock>();
    stmts.set(SCHEMA_META_SELECT, makeStmt({ get: { value: 'true' } }));

    const db = makeDbStub(stmts);
    const { secrets } = makeSecretSink(tmpDir);
    const service = new LegacyImportService(db, secrets);

    const result = service.importElectronStoreIfNeeded(pathsInput());

    expect(result).toEqual({ imported: false, reason: 'already-imported' });
    // No update to schema_meta, no touch of app_settings SELECT
    expect(stmts.get(APP_SETTINGS_UPDATE)).toBeUndefined();
  });

  it('returns existing-data (and marks complete) when the main DB already has an onboarded user', () => {
    const stmts = new Map<string, StmtMock>();
    stmts.set(SCHEMA_META_SELECT, makeStmt({ get: undefined }));
    stmts.set(APP_SETTINGS_SELECT, makeStmt({ get: { onboarding_complete: 1 } }));
    const upsert = makeStmt();
    stmts.set(SCHEMA_META_UPSERT, upsert);

    const db = makeDbStub(stmts);
    const { secrets } = makeSecretSink(tmpDir);
    const service = new LegacyImportService(db, secrets);

    const result = service.importElectronStoreIfNeeded(pathsInput());

    expect(result).toEqual({ imported: false, reason: 'existing-data' });
    expect(upsert.run).toHaveBeenCalledWith('legacy_electron_store_import_complete', 'true');
  });

  it('runs the three import stages when no flag is set and no existing data', () => {
    // Legacy JSON files on disk
    fs.writeFileSync(
      appSettingsPath,
      JSON.stringify({
        debugMode: true,
        onboardingComplete: true,
        selectedModel: { provider: 'anthropic', model: 'claude' },
        ollamaConfig: null,
        litellmConfig: null,
      }),
    );
    fs.writeFileSync(
      providerSettingsPath,
      JSON.stringify({
        activeProviderId: 'anthropic',
        debugMode: false,
        connectedProviders: {
          anthropic: {
            connectionStatus: 'connected',
            selectedModelId: 'claude-opus',
            credentials: { type: 'api_key' },
            lastConnectedAt: '2024-01-01T00:00:00Z',
          },
        },
      }),
    );
    fs.writeFileSync(
      taskHistoryPath,
      JSON.stringify({
        tasks: [
          {
            id: 't1',
            prompt: 'hello',
            summary: null,
            status: 'completed',
            sessionId: 's1',
            createdAt: '2024-01-01T00:00:00Z',
            startedAt: null,
            completedAt: null,
            messages: [
              {
                id: 'm1',
                type: 'user',
                content: 'hi',
                toolName: null,
                toolInput: null,
                timestamp: '2024-01-01T00:00:01Z',
                attachments: null,
              },
            ],
          },
        ],
      }),
    );

    const stmts = new Map<string, StmtMock>();
    // No-flag, no-data
    stmts.set(SCHEMA_META_SELECT, makeStmt({ get: undefined }));
    stmts.set(APP_SETTINGS_SELECT, makeStmt({ get: { onboarding_complete: 0 } }));
    stmts.set(PROVIDER_COUNT_SELECT, makeStmt({ get: { count: 0 } }));
    stmts.set(TASK_COUNT_SELECT, makeStmt({ get: { count: 0 } }));

    const appUpdate = makeStmt();
    const providerMetaUpdate = makeStmt();
    const providerInsert = makeStmt();
    const taskInsert = makeStmt({ run: { changes: 1 } });
    const messageInsert = makeStmt();
    const upsert = makeStmt();

    stmts.set(APP_SETTINGS_UPDATE, appUpdate);
    stmts.set(PROVIDER_META_UPDATE, providerMetaUpdate);
    stmts.set(
      'INSERT OR IGNORE INTO providers (provider_id, connection_status, selected_model_id, credentials_type, credentials_data, last_connected_at, available_models) VALUES (?, ?, ?, ?, ?, ?, ?)',
      providerInsert,
    );
    stmts.set(
      'INSERT OR IGNORE INTO tasks (id, prompt, summary, status, session_id, created_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      taskInsert,
    );
    stmts.set(
      'INSERT OR IGNORE INTO task_messages (id, task_id, type, content, tool_name, tool_input, timestamp, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      messageInsert,
    );
    stmts.set(SCHEMA_META_UPSERT, upsert);

    const db = makeDbStub(stmts);
    const { secrets } = makeSecretSink(tmpDir);
    const service = new LegacyImportService(db, secrets);

    const result = service.importElectronStoreIfNeeded(pathsInput());

    expect(result).toEqual({ imported: true, reason: 'completed' });

    expect(appUpdate.run).toHaveBeenCalledTimes(1);
    expect(appUpdate.run).toHaveBeenCalledWith(
      1, // debugMode
      1, // onboardingComplete
      JSON.stringify({ provider: 'anthropic', model: 'claude' }),
      JSON.stringify(null),
      JSON.stringify(null),
    );

    expect(providerMetaUpdate.run).toHaveBeenCalledWith('anthropic', 0);
    expect(providerInsert.run).toHaveBeenCalledWith(
      'anthropic',
      'connected',
      'claude-opus',
      'api_key',
      JSON.stringify({ type: 'api_key' }),
      '2024-01-01T00:00:00Z',
      JSON.stringify(null),
    );

    expect(taskInsert.run).toHaveBeenCalledTimes(1);
    expect(messageInsert.run).toHaveBeenCalledTimes(1);

    // Completion flag gets written regardless of whether any specific stage
    // produced rows — the guard runs on a flag, not on row counts.
    expect(upsert.run).toHaveBeenCalledWith('legacy_electron_store_import_complete', 'true');
  });

  it('treats missing JSON files as empty (and still marks complete)', () => {
    // No files on disk this time.
    const stmts = new Map<string, StmtMock>();
    stmts.set(SCHEMA_META_SELECT, makeStmt({ get: undefined }));
    stmts.set(APP_SETTINGS_SELECT, makeStmt({ get: { onboarding_complete: 0 } }));
    stmts.set(PROVIDER_COUNT_SELECT, makeStmt({ get: { count: 0 } }));
    stmts.set(TASK_COUNT_SELECT, makeStmt({ get: { count: 0 } }));
    const upsert = makeStmt();
    stmts.set(SCHEMA_META_UPSERT, upsert);

    const db = makeDbStub(stmts);
    const { secrets } = makeSecretSink(tmpDir);
    const service = new LegacyImportService(db, secrets);

    const result = service.importElectronStoreIfNeeded(pathsInput());

    expect(result).toEqual({ imported: true, reason: 'completed' });
    // No UPDATE/INSERT for the three import stages because each JSON was empty.
    expect(stmts.get(APP_SETTINGS_UPDATE)).toBeUndefined();
    expect(stmts.get(PROVIDER_META_UPDATE)).toBeUndefined();
    // Completion flag still set — this is the idempotency guarantee.
    expect(upsert.run).toHaveBeenCalledWith('legacy_electron_store_import_complete', 'true');
  });

  it('soft-fails on malformed JSON: logs a warning, continues the other stages, marks complete', () => {
    fs.writeFileSync(appSettingsPath, '{ this is not json');
    // provider-settings + task-history files absent

    const stmts = new Map<string, StmtMock>();
    stmts.set(SCHEMA_META_SELECT, makeStmt({ get: undefined }));
    stmts.set(APP_SETTINGS_SELECT, makeStmt({ get: { onboarding_complete: 0 } }));
    stmts.set(PROVIDER_COUNT_SELECT, makeStmt({ get: { count: 0 } }));
    stmts.set(TASK_COUNT_SELECT, makeStmt({ get: { count: 0 } }));
    const upsert = makeStmt();
    stmts.set(SCHEMA_META_UPSERT, upsert);

    const db = makeDbStub(stmts);
    const { secrets } = makeSecretSink(tmpDir);
    const service = new LegacyImportService(db, secrets);

    const result = service.importElectronStoreIfNeeded(pathsInput());

    // Even with a corrupt JSON file we mark complete — replaying would just
    // log the same warning again on every boot.
    expect(result).toEqual({ imported: true, reason: 'completed' });
    expect(upsert.run).toHaveBeenCalledWith('legacy_electron_store_import_complete', 'true');
  });

  // ── Phase 3 M2 T5 — credential ROUTE + STRIP (audit §18.3.1 root fix) ────

  /** Stub DB with the standard no-flag no-data selects + captured inserts. */
  function stubbedDbForImport() {
    const stmts = new Map<string, StmtMock>();
    stmts.set(SCHEMA_META_SELECT, makeStmt({ get: undefined }));
    stmts.set(APP_SETTINGS_SELECT, makeStmt({ get: { onboarding_complete: 0 } }));
    stmts.set(PROVIDER_COUNT_SELECT, makeStmt({ get: { count: 0 } }));
    stmts.set(TASK_COUNT_SELECT, makeStmt({ get: { count: 0 } }));
    const providerInsert = makeStmt();
    stmts.set(
      'INSERT OR IGNORE INTO providers (provider_id, connection_status, selected_model_id, credentials_type, credentials_data, last_connected_at, available_models) VALUES (?, ?, ?, ?, ?, ?, ?)',
      providerInsert,
    );
    const upsert = makeStmt();
    stmts.set(SCHEMA_META_UPSERT, upsert);
    return { db: makeDbStub(stmts), providerInsert, upsert, stmts };
  }

  /** The persisted settings.getAll-shaped response built from the insert row. */
  function persistedProviderRows(insertMock: StmtMock): Map<string, Record<string, string>> {
    const rows = new Map<string, Record<string, string>>();
    for (const call of insertMock.run.mock.calls) {
      const [providerId, , , credentialsType, credentialsData] = call as unknown[];
      rows.set(providerId as string, {
        credentials_type: credentialsType as string,
        credentials_data: credentialsData as string,
      });
    }
    return rows;
  }

  function assertNoSecretMaterial(value: unknown, plaintexts: string[]): void {
    const serialized = JSON.stringify(value) ?? '';
    for (const plaintext of plaintexts) {
      // (a) substring absence — the plaintext value never survives.
      expect(serialized).not.toContain(plaintext);
    }
    // (b) deep key-name absence — no secret-named field survives either.
    for (const key of [
      'apiKey',
      'secretKey',
      'secretAccessKey',
      'sessionToken',
      'password',
      'refreshToken',
      'accessToken',
      'serviceAccountJson',
      'token',
      'clientSecret',
      'accessKeyId',
    ]) {
      expect(collectKeysDeep(value)).not.toContain(key);
    }
  }

  it('T5: routes api_key credentials into secure storage and strips them from the persisted blob (audit root fix)', () => {
    // Audited legacy shapes: plaintext apiKey riding the credentials blob —
    // top-level (anthropic), masked-prefix alongside (custom), and nested
    // inside a non-secret metadata object.
    fs.writeFileSync(
      providerSettingsPath,
      JSON.stringify({
        activeProviderId: 'anthropic',
        debugMode: false,
        connectedProviders: {
          anthropic: {
            connectionStatus: 'connected',
            selectedModelId: 'claude-opus',
            credentials: { type: 'api_key', apiKey: PLAINTEXTS.anthropic },
            lastConnectedAt: '2024-01-01T00:00:00Z',
          },
          custom: {
            connectionStatus: 'connected',
            selectedModelId: 'custom/m',
            credentials: {
              type: 'custom',
              baseUrl: 'https://api.example.com/v1',
              modelName: 'm',
              hasApiKey: true,
              apiKey: PLAINTEXTS.custom,
            },
            lastConnectedAt: '2024-01-01T00:00:00Z',
          },
          moonshot: {
            connectionStatus: 'connected',
            selectedModelId: null,
            credentials: {
              type: 'moonshot',
              upstream: { meta: { apiKey: PLAINTEXTS.nested } },
              keyPrefix: 'mo24',
            },
            lastConnectedAt: '2024-01-01T00:00:00Z',
          },
        },
      }),
    );

    const { db, providerInsert } = stubbedDbForImport();
    const sink = makeSecretSink(tmpDir);
    const service = new LegacyImportService(db, sink.secrets);
    expect(service.importElectronStoreIfNeeded(pathsInput())).toEqual({
      imported: true,
      reason: 'completed',
    });

    // (a) Secrets storage has the keys readable via the service's own read —
    // through the SAME encrypted backend live provider keys use.
    expect(sink.secrets.getApiKey('anthropic')).toBe(PLAINTEXTS.anthropic);
    expect(sink.secrets.getApiKey('custom')).toBe(PLAINTEXTS.custom);
    expect(sink.secrets.getApiKey('moonshot')).toBe(PLAINTEXTS.nested);
    expect(sink.storeSpy).toHaveBeenCalledTimes(3);

    // (b) The persisted settings blob carries NO plaintext (substring) and NO
    // secret-named field at any depth, and the settings.getAll-shaped parse
    // of that blob is clean too. Structural metadata survives for the UI.
    const rows = persistedProviderRows(providerInsert);
    const settingsAllShape = {
      providers: {
        connectedProviders: Object.fromEntries(
          [...rows.entries()].map(([providerId, row]) => [
            providerId,
            { credentials: credentialsServedBySettings(row.credentials_data) },
          ]),
        ),
      },
    };
    assertNoSecretMaterial(settingsAllShape, Object.values(PLAINTEXTS));
    const blobs = [...rows.values()].map((r) => JSON.parse(r.credentials_data));
    expect(blobs).toEqual([
      // anthropic: apiKey stripped; masked display fragment derived (no legacy prefix present)
      { keyPrefix: 'sk-a', type: 'api_key' },
      // custom: apiKey stripped; derived masked fragment alongside the kept
      // structural metadata (hasApiKey, endpoints)
      {
        baseUrl: 'https://api.example.com/v1',
        hasApiKey: true,
        keyPrefix: 'sk-c',
        modelName: 'm',
        type: 'custom',
      },
      // moonshot: nested apiKey stripped; unrelated keyPrefix + nesting kept
      { keyPrefix: 'mo24', type: 'moonshot', upstream: { meta: {} } },
    ]);
  });

  it('T5: routes bedrock/vertex credential documents into their documented storage buckets', () => {
    /** One import run over a fresh stub DB + fresh sink; fixture = providerSettings JSON. */
    function importOnce(connectedProviders: Record<string, unknown>) {
      fs.writeFileSync(
        providerSettingsPath,
        JSON.stringify({ activeProviderId: 'bedrock', debugMode: false, connectedProviders }),
      );
      const { db, providerInsert } = stubbedDbForImport();
      const sink = makeSecretSink(tmpDir);
      new LegacyImportService(db, sink.secrets).importElectronStoreIfNeeded(pathsInput());
      return { sink, rows: persistedProviderRows(providerInsert) };
    }

    // ── accessKeys variant: the identifier half moves INTO the document (and
    // out of the ledger) alongside the secret half. ──
    const access = importOnce({
      bedrock: {
        connectionStatus: 'connected',
        selectedModelId: null,
        credentials: {
          type: 'bedrock',
          authMethod: 'accessKey',
          region: 'us-east-1',
          accessKeyId: PLAINTEXTS.bedrockAccessKeyId,
          secretAccessKey: PLAINTEXTS.bedrockSecretKey,
          sessionToken: PLAINTEXTS.bedrockSessionToken,
        },
        lastConnectedAt: '2024-01-01T00:00:00Z',
      },
    });
    expect(access.sink.bedrockSpy).toHaveBeenCalledTimes(1);
    // getBedrockCredentials = the service's own read of the document bucket.
    expect(access.sink.secrets.getBedrockCredentials()).toEqual({
      authType: 'accessKeys',
      accessKeyId: PLAINTEXTS.bedrockAccessKeyId,
      secretAccessKey: PLAINTEXTS.bedrockSecretKey,
      sessionToken: PLAINTEXTS.bedrockSessionToken,
      region: 'us-east-1',
    });
    const accessBlob = JSON.parse(access.rows.get('bedrock')?.credentials_data ?? '{}');
    // The blob loses BOTH credential halves; a masked display prefix survives.
    expect(accessBlob).toEqual({
      authMethod: 'accessKey',
      accessKeyIdPrefix: 'AKIALIVE...',
      region: 'us-east-1',
      type: 'bedrock',
    });

    // ── apiKey variant: the doc carries the key; the blob shows the 8-char
    // masked prefix (desktop BedrockProviderForm convention). ──
    const keyVariant = importOnce({
      bedrock: {
        connectionStatus: 'connected',
        selectedModelId: null,
        credentials: {
          type: 'bedrock',
          authMethod: 'apiKey',
          region: 'eu-west-1',
          apiKey: PLAINTEXTS.bedrockApiKey,
        },
        lastConnectedAt: '2024-01-01T00:00:00Z',
      },
    });
    expect(keyVariant.sink.secrets.getBedrockCredentials()).toEqual({
      authType: 'apiKey',
      apiKey: PLAINTEXTS.bedrockApiKey,
      region: 'eu-west-1',
    });
    const keyVariantBlob = JSON.parse(keyVariant.rows.get('bedrock')?.credentials_data ?? '{}');
    expect(keyVariantBlob).toEqual({
      authMethod: 'apiKey',
      apiKeyPrefix: 'bb_LIVE_...',
      region: 'eu-west-1',
      type: 'bedrock',
    });

    // ── vertex service-account variant: object-valued SA document stored as
    // the whole typed document under 'vertex' (desktop vertex:save parity);
    // an adc sibling routes nothing (ADC needs no stored secret). ──
    const vertex = importOnce({
      vertex: {
        connectionStatus: 'connected',
        selectedModelId: null,
        credentials: {
          type: 'vertex',
          authMethod: 'serviceAccount',
          projectId: 'proj-1',
          location: 'us-central1',
          serviceAccountJson: { private_key: PLAINTEXTS.serviceAccountPrivateKey },
        },
        lastConnectedAt: '2024-01-01T00:00:00Z',
      },
      vertexAdc: {
        connectionStatus: 'connected',
        selectedModelId: null,
        credentials: {
          type: 'vertex',
          authMethod: 'adc',
          projectId: 'proj-1',
          location: 'us-central1',
          serviceAccountEmail: 'ops@proj-1.iam.gserviceaccount.com',
        },
        lastConnectedAt: '2024-01-01T00:00:00Z',
      },
    });
    const vertexStored = vertex.sink.secrets.getApiKey('vertex');
    expect(JSON.parse(vertexStored ?? 'null')).toEqual({
      authType: 'serviceAccount',
      serviceAccountJson: JSON.stringify({ private_key: PLAINTEXTS.serviceAccountPrivateKey }),
      projectId: 'proj-1',
      location: 'us-central1',
    });
    const vertexBlob = JSON.parse(vertex.rows.get('vertex')?.credentials_data ?? '{}');
    expect(vertexBlob).toEqual({
      authMethod: 'serviceAccount',
      location: 'us-central1',
      projectId: 'proj-1',
      type: 'vertex',
    });
    // ADC variant: structural metadata only, no secure-storage routing needed.
    expect(JSON.parse(vertex.rows.get('vertexAdc')?.credentials_data ?? '{}')).toEqual({
      authMethod: 'adc',
      location: 'us-central1',
      projectId: 'proj-1',
      serviceAccountEmail: 'ops@proj-1.iam.gserviceaccount.com',
      type: 'vertex',
    });
  });

  it('T5: empty/null credential entries route nothing and keep their historical blob shape', () => {
    fs.writeFileSync(
      providerSettingsPath,
      JSON.stringify({
        activeProviderId: 'anthropic',
        debugMode: false,
        connectedProviders: {
          nullish: {
            connectionStatus: 'connected',
            selectedModelId: null,
            credentials: null,
            lastConnectedAt: '2024-01-01T00:00:00Z',
          },
          empty: {
            connectionStatus: 'connected',
            selectedModelId: null,
            credentials: { type: 'api_key', keyPrefix: '' },
            lastConnectedAt: '2024-01-01T00:00:00Z',
          },
          blankKey: {
            connectionStatus: 'connected',
            selectedModelId: null,
            credentials: { type: 'api_key', apiKey: '' },
            lastConnectedAt: '2024-01-01T00:00:00Z',
          },
          rawVariant: {
            connectionStatus: 'connected',
            selectedModelId: null,
            credentials: PLAINTEXTS.rawVariant,
            lastConnectedAt: '2024-01-01T00:00:00Z',
          },
          unroutable: {
            connectionStatus: 'connected',
            selectedModelId: null,
            credentials: { type: 'oauth2', token: 'tok_LIVE-0123456789abcdef' },
            lastConnectedAt: '2024-01-01T00:00:00Z',
          },
        },
      }),
    );

    const { db, providerInsert } = stubbedDbForImport();
    const sink = makeSecretSink(tmpDir);
    const service = new LegacyImportService(db, sink.secrets);
    expect(service.importElectronStoreIfNeeded(pathsInput())).toEqual({
      imported: true,
      reason: 'completed',
    });

    const rows = persistedProviderRows(providerInsert);
    expect(JSON.parse(rows.get('nullish')?.credentials_data ?? '')).toEqual({});
    expect(JSON.parse(rows.get('empty')?.credentials_data ?? '')).toEqual({
      keyPrefix: '',
      type: 'api_key',
    });
    expect(JSON.parse(rows.get('blankKey')?.credentials_data ?? '')).toEqual({ type: 'api_key' });

    // Raw-string variant: the key routes into secure storage; the ledger
    // keeps a masked display blob.
    expect(sink.secrets.getApiKey('rawVariant')).toBe(PLAINTEXTS.rawVariant);
    expect(JSON.parse(rows.get('rawVariant')?.credentials_data ?? '')).toEqual({
      keyPrefix: 'sk-r',
      type: 'api_key',
    });

    // Unroutable material (no credential consumer for the type): stripped
    // from the ledger, NOT routed blind — the plaintext never persists.
    const settingsAllShape = {
      providers: {
        connectedProviders: Object.fromEntries(
          [...rows.entries()].map(([providerId, row]) => [
            providerId,
            { credentials: credentialsServedBySettings(row.credentials_data) },
          ]),
        ),
      },
    };
    assertNoSecretMaterial(settingsAllShape, ['tok_LIVE-0123456789abcdef', PLAINTEXTS.rawVariant]);
    expect(sink.secrets.getApiKey('unroutable')).toBeNull();
  });

  it('T5: a live stored key is never clobbered by the import; replays lose and duplicate nothing', () => {
    fs.writeFileSync(
      providerSettingsPath,
      JSON.stringify({
        activeProviderId: 'anthropic',
        debugMode: false,
        connectedProviders: {
          anthropic: {
            connectionStatus: 'connected',
            selectedModelId: 'claude-opus',
            credentials: { type: 'api_key', apiKey: PLAINTEXTS.anthropic },
            lastConnectedAt: '2024-01-01T00:00:00Z',
          },
          fresh: {
            connectionStatus: 'connected',
            selectedModelId: null,
            credentials: { type: 'api_key', apiKey: PLAINTEXTS.custom },
            lastConnectedAt: '2024-01-01T00:00:00Z',
          },
        },
      }),
    );

    // A live key for anthropic already exists in secure storage (newer than
    // anything in the legacy file). Clear the spy first — it must count only
    // import-routing calls, not the seeding call.
    const sink = makeSecretSink(tmpDir);
    sink.secrets.storeApiKey('anthropic', 'sk-live-newer-KEEP');
    sink.storeSpy.mockClear();
    const { db, providerInsert } = stubbedDbForImport();
    const service = new LegacyImportService(db, sink.secrets);
    expect(service.importElectronStoreIfNeeded(pathsInput())).toEqual({
      imported: true,
      reason: 'completed',
    });

    expect(sink.secrets.getApiKey('anthropic')).toBe('sk-live-newer-KEEP');
    expect(sink.storeSpy.mock.calls.filter(([provider]) => provider === 'anthropic')).toHaveLength(
      0,
    );
    // The legacy plaintext is stripped from the ledger AND not routed over
    // the live key; the blob keeps only the display metadata it carried.
    const rows = persistedProviderRows(providerInsert);
    expect(rows.get('anthropic')?.credentials_data).not.toContain(PLAINTEXTS.anthropic);
    expect(
      collectKeysDeep(JSON.parse(rows.get('anthropic')?.credentials_data ?? '')),
    ).not.toContain('apiKey');

    // Idempotent re-import: with the completion flag cleared the stages run
    // again (INSERT OR IGNORE) but the sink never stores again — the keys
    // stay readable, single-valued, and byte-stable.
    sink.storeSpy.mockClear();
    const stmts2 = new Map<string, StmtMock>();
    stmts2.set(SCHEMA_META_SELECT, makeStmt({ get: undefined }));
    stmts2.set(APP_SETTINGS_SELECT, makeStmt({ get: { onboarding_complete: 0 } }));
    stmts2.set(PROVIDER_COUNT_SELECT, makeStmt({ get: { count: 0 } }));
    stmts2.set(TASK_COUNT_SELECT, makeStmt({ get: { count: 0 } }));
    const providerInsert2 = makeStmt();
    stmts2.set(
      'INSERT OR IGNORE INTO providers (provider_id, connection_status, selected_model_id, credentials_type, credentials_data, last_connected_at, available_models) VALUES (?, ?, ?, ?, ?, ?, ?)',
      providerInsert2,
    );
    const upsert2 = makeStmt();
    stmts2.set(SCHEMA_META_UPSERT, upsert2);
    const service2 = new LegacyImportService(makeDbStub(stmts2), sink.secrets);
    expect(service2.importElectronStoreIfNeeded(pathsInput())).toEqual({
      imported: true,
      reason: 'completed',
    });
    // No additional stores — nothing duplicated, nothing clobbered. Both
    // providers now hold live keys, so the replay routes nothing at all.
    expect(sink.storeSpy).toHaveBeenCalledTimes(0);
    expect(upsert2.run).toHaveBeenCalledWith('legacy_electron_store_import_complete', 'true');
    expect(sink.secrets.getApiKey('anthropic')).toBe('sk-live-newer-KEEP');
    expect(sink.secrets.getApiKey('fresh')).toBe(PLAINTEXTS.custom);
    // Re-persisted blob is byte-identical to run #1's (INSERT OR IGNORE parity).
    const rows2 = persistedProviderRows(providerInsert2);
    expect(rows2.get('anthropic')?.credentials_data).toEqual(
      rows.get('anthropic')?.credentials_data,
    );
    expect(rows2.get('fresh')?.credentials_data).toEqual(rows.get('fresh')?.credentials_data);
  });
});
