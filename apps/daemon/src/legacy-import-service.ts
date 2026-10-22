/**
 * LegacyImportService — ports the old desktop-side electron-store JSON
 * importer to the daemon, WITHOUT taking a runtime dep on `electron-store`.
 *
 * Milestone 2 of the daemon-only-SQLite migration
 * (plan: /Users/yanai/.claude/plans/squishy-exploring-hamster.md).
 *
 * Why not just `new Store({ name })` like the desktop helper?
 * - `electron-store` pulls Electron-adjacent deps (`conf`, `env-paths`,
 *   `atomically`) into the daemon bundle needlessly. Those aren't a
 *   correctness issue but they're noise.
 * - The daemon receives explicit `.json` paths from its caller (main, via
 *   RPC params or CLI args). We don't need the library's path resolution.
 * - Parsing the JSON file directly keeps the daemon free of any
 *   `electron-store` upgrade surface.
 *
 * On-disk format (per electron-store):
 *   - File at `<userData>/<storeName>.json` containing a plain JSON object.
 *   - Missing file means empty store — NOT an error.
 *   - Malformed JSON is a soft-failure: log and skip the category, don't
 *     abort the whole import.
 *
 * Phase 3 M2 T5 — audit root fix (checkpoint §18.3.1, the M2 candidate):
 * the legacy `connectedProviders[*].credentials` blob used to be persisted
 * into SQLite verbatim, so plaintext `apiKey`-shaped values surfaced through
 * `settings.getAll` / `provider.getSettings` (the M1 universal gateway
 * scrubber covered reads as defense in depth). The root fix moves the
 * handling to import time:
 *
 *   1. ROUTE — any credential material found in a legacy blob is written to
 *      the daemon's own secure-storage backend via `SecretsService`
 *      (`storeApiKey(provider, key)`; bedrock/vertex credential documents to
 *      their documented buckets), so post-import provider flows (opencode
 *      config generation, fetch/test/validate) behave identically to keys
 *      stored by the live connect flows.
 *   2. STRIP — every secret-named field is removed from the blob BEFORE the
 *      `providers.credentials_data` persistence (structural metadata kept:
 *      type, keyPrefix, region, …). The imported settings surface carries
 *      NO key material even without the gateway scrubber.
 *
 * Guarded by `schema_meta.legacy_electron_store_import_complete`. Idempotent:
 * a second call is a no-op once the flag is set, and additionally a
 * provider's live stored key is never clobbered by a replay (`getApiKey`
 * non-null ⇒ skip) — a replay can neither lose nor duplicate keys.
 */
import * as fs from 'node:fs';
import type { Database } from 'better-sqlite3';
import { log } from './logger.js';

const LEGACY_IMPORT_KEY = 'legacy_electron_store_import_complete';

/**
 * The secure-storage seam the import routes extracted credential material
 * through — structurally satisfied by `SecretsService`, i.e. the SAME
 * encrypted backend the daemon's own keys live in. Legacy material must
 * never persist anywhere else.
 */
export interface LegacyImportSecretSink {
  storeApiKey(provider: string, apiKey: string): void;
  getApiKey(provider: string): string | null;
  storeBedrockCredentials(credentials: string): void;
}

/**
 * Field names whose values inside a legacy credentials blob are treated as
 * secret material. Name-exact mirror of the host gateway's
 * `SECRET_FIELD_NAMES` (apps/host/src/provider-settings-scrubber.ts — the
 * daemon deliberately does not import from the host app), so both layers
 * reason about identical shapes even though the strip now happens at the
 * source. Values kept under these names in the blob are removed BEFORE
 * persistence; the gateway scrubber remains defense in depth for reads.
 */
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
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
]);

/** Credential material extracted from a legacy credentials blob. */
interface LegacyCredentialMaterial {
  /** Secret-named field the value was found under. */
  field: string;
  /** Non-empty string key material, or a plain object = JSON credential document. */
  value: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Non-empty string key material, or a non-empty (JSON-credential) object. */
function isCredentialMaterial(value: unknown): boolean {
  return isNonEmptyString(value) || (isPlainObject(value) && Object.keys(value).length > 0);
}

/**
 * Walk `blob` and return the order-preserving copy with every secret-named
 * field removed, collecting the removed values as credential material. A
 * plain object under a secret name is treated as a whole JSON credential
 * document (collected as-is, not descended into). Depth bound mirrors the
 * gateway scrubber's MAX_SCRUB_DEPTH for equivalence.
 */
function stripAndCollectCredentialMaterial(
  value: unknown,
  materials: LegacyCredentialMaterial[],
  depth = 0,
): unknown {
  if (depth > 32) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripAndCollectCredentialMaterial(item, materials, depth + 1));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      if (isCredentialMaterial(entry)) {
        materials.push({ field: key, value: entry });
      }
      continue;
    }
    clean[key] = stripAndCollectCredentialMaterial(entry, materials, depth + 1);
  }
  return clean;
}

/**
 * Assemble the legacy BedrockCredentials DOCUMENT the daemon's storage bucket
 * for 'bedrock' expects (`secrets.getBedrockCredentials` parses it; desktop
 * bedrock:save / web saveBedrockCredentials store the same shape).
 * `authMethod` in the legacy blob maps to `authType` in the document.
 */
function buildLegacyBedrockDocument(
  blob: Record<string, unknown>,
  materials: LegacyCredentialMaterial[],
): Record<string, unknown> | null {
  const region = isNonEmptyString(blob.region) ? blob.region : 'us-east-1';
  const apiKey = materials.find((m) => m.field === 'apiKey' && isNonEmptyString(m.value));
  if (apiKey) {
    return { authType: 'apiKey', apiKey: apiKey.value, region };
  }
  const secretAccessKey = materials.find(
    (m) => m.field === 'secretAccessKey' && isNonEmptyString(m.value),
  );
  if (secretAccessKey) {
    const accessKeyId = isNonEmptyString(blob.accessKeyId) ? blob.accessKeyId : '';
    if (!accessKeyId) {
      return null;
    }
    const sessionToken = materials.find(
      (m) => m.field === 'sessionToken' && isNonEmptyString(m.value),
    );
    return {
      authType: 'accessKeys',
      accessKeyId,
      secretAccessKey: secretAccessKey.value,
      ...(sessionToken ? { sessionToken: sessionToken.value } : {}),
      region,
    };
  }
  const document = materials.find((m) => isPlainObject(m.value) && Object.keys(m.value).length > 0);
  return document ? (document.value as Record<string, unknown>) : null;
}

/**
 * Assemble the legacy VertexCredentials DOCUMENT the bucket for 'vertex'
 * expects (desktop vertex:save / web saveVertexCredentials store the whole
 * document JSON via `storeApiKey('vertex', json)`; `provider.fetchModels`
 * ('vertex') parses it). A non-string `serviceAccountJson` (the SA document
 * embedded as an object) is re-serialized to the typed string form.
 */
function buildLegacyVertexDocument(
  blob: Record<string, unknown>,
  materials: LegacyCredentialMaterial[],
): Record<string, unknown> | null {
  const projectId = isNonEmptyString(blob.projectId) ? blob.projectId : '';
  const location = isNonEmptyString(blob.location) ? blob.location : '';
  if (!projectId || !location) {
    return null;
  }
  if (blob.authMethod === 'adc') {
    return { authType: 'adc', projectId, location };
  }
  const serviceAccountJson = materials.find(
    (m) => m.field === 'serviceAccountJson' && isCredentialMaterial(m.value),
  );
  if (!serviceAccountJson) {
    return null;
  }
  const serialized = isNonEmptyString(serviceAccountJson.value)
    ? serviceAccountJson.value
    : JSON.stringify(serviceAccountJson.value);
  return { authType: 'serviceAccount', serviceAccountJson: serialized, projectId, location };
}

export type LegacyImportPaths = {
  /** Full path to the legacy `app-settings{,-dev}.json` file. */
  appSettingsPath: string;
  /** Full path to the legacy `provider-settings{,-dev}.json` file. */
  providerSettingsPath: string;
  /** Full path to the legacy `task-history{,-dev}.json` file. */
  taskHistoryPath: string;
};

export type LegacyImportResult =
  | { imported: true; reason: 'completed' }
  | { imported: false; reason: 'already-imported' }
  | { imported: false; reason: 'existing-data' };

function readJsonOrEmpty(path: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(path)) {
      return {};
    }
    const raw = fs.readFileSync(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn(`[LegacyImport] ${path}: top-level is not a JSON object, skipping`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    log.warn(`[LegacyImport] Failed to read/parse ${path}: ${String(err)}`);
    return {};
  }
}

function wasAttempted(db: Database): boolean {
  try {
    const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(LEGACY_IMPORT_KEY) as
      | { value: string }
      | undefined;
    return row?.value === 'true';
  } catch {
    return false;
  }
}

function hasExistingUserData(db: Database): boolean {
  try {
    const settings = db
      .prepare('SELECT onboarding_complete FROM app_settings WHERE id = 1')
      .get() as { onboarding_complete: number } | undefined;
    if (settings?.onboarding_complete === 1) {
      return true;
    }
    const providerCount = db.prepare('SELECT COUNT(*) as count FROM providers').get() as
      | { count: number }
      | undefined;
    if (providerCount && providerCount.count > 0) {
      return true;
    }
    const taskCount = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as
      | { count: number }
      | undefined;
    if (taskCount && taskCount.count > 0) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function markComplete(db: Database): void {
  try {
    db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run(
      LEGACY_IMPORT_KEY,
      'true',
    );
  } catch (err) {
    log.error(`[LegacyImport] Failed to mark import complete: ${String(err)}`);
  }
}

function importAppSettings(db: Database, appSettingsPath: string): void {
  const legacy = readJsonOrEmpty(appSettingsPath);
  if (Object.keys(legacy).length === 0) {
    log.info(`[LegacyImport] No app-settings to import (${appSettingsPath})`);
    return;
  }
  try {
    db.prepare(
      `UPDATE app_settings SET
        debug_mode = ?,
        onboarding_complete = ?,
        selected_model = ?,
        ollama_config = ?,
        litellm_config = ?
      WHERE id = 1`,
    ).run(
      legacy.debugMode ? 1 : 0,
      legacy.onboardingComplete ? 1 : 0,
      JSON.stringify(legacy.selectedModel ?? null),
      JSON.stringify(legacy.ollamaConfig ?? null),
      JSON.stringify(legacy.litellmConfig ?? null),
    );
    log.info('[LegacyImport] App settings imported');
  } catch (err) {
    log.error(`[LegacyImport] Failed to import app-settings: ${String(err)}`);
  }
}

/**
 * ROUTE + STRIP step for one legacy credentials value (audit root fix
 * §18.3.1). Returns the credentials_type + the SANITIZED blob to persist.
 *
 * Routing rules — exactly ONE secure-storage entry per provider per run:
 *   - bedrock → BedrockCredentials DOCUMENT via `storeBedrockCredentials`
 *     (the bucket `getBedrockCredentials` / `provider.fetchModels('bedrock')`
 *     parse): `apiKey` material → `{authType:'apiKey', ...}`, a
 *     `secretAccessKey` + blob-side `accessKeyId` pair → the accessKeys
 *     document (the identifier half moves into the document, out of the
 *     ledger), or a verbatim JSON-credential object found under a secret
 *     name. Missing display prefixes are re-derived (8-char + '...' — the
 *     desktop BedrockProviderForm convention).
 *   - vertex  → VertexCredentials DOCUMENT via `storeApiKey('vertex', json)`
 *     (desktop `vertex:save` parity — the daemon's
 *     `provider.fetchModels('vertex')` parses the whole document); an
 *     object-valued service-account document is re-serialized into the typed
 *     `serviceAccountJson` string form. ADC rows carry no material.
 *   - other   → non-empty `apiKey` string via `storeApiKey(provider, key)` —
 *     the same raw-key bucket every classic provider's secure-storage read
 *     uses; `keyPrefix` re-derived from the routed key (4-char fragment,
 *     the masked-read convention) when the legacy blob carries none.
 *
 * Everything under a secret name is STRIPPED regardless of routing. Material
 * with no secure-storage route for its type (e.g. stray token/password
 * strings on classic blobs) is dropped with a loud warning — never persisted,
 * never routed blind. Generic raw-key buckets are string consumers, so
 * JSON-credential objects are only routed into the bedrock/vertex document
 * buckets that actually parse them back.
 *
 * A live stored key (`getApiKey` non-null) is NEVER clobbered — routing is
 * skipped for that provider, so a replay over an in-use profile is
 * stale-safe (no key loss, no duplicates).
 */
function routeAndStripLegacyCredentials(
  providerId: string,
  credentials: unknown,
  secrets: LegacyImportSecretSink,
): { credentialsType: string; blob: string } {
  if (isPlainObject(credentials)) {
    const materials: LegacyCredentialMaterial[] = [];
    const stripped = stripAndCollectCredentialMaterial(credentials, materials) as Record<
      string,
      unknown
    >;
    const credentialsType = isNonEmptyString(stripped.type) ? stripped.type : 'api_key';

    if (materials.length > 0) {
      const liveKey = secrets.getApiKey(providerId);
      if (liveKey !== null) {
        // A live stored key wins — a replayed import must not clobber it.
        // The masked display fragment still follows whatever key actually
        // lives in storage, so the served metadata stays truthful AND a
        // replayed import persists a byte-stable blob.
        if (!isNonEmptyString(stripped.keyPrefix)) {
          stripped.keyPrefix = liveKey.slice(0, 4);
        }
        log.info(
          `[LegacyImport] ${providerId}: live stored key present — import material stripped without routing`,
        );
      } else if (credentialsType === 'bedrock') {
        const document = buildLegacyBedrockDocument(stripped, materials);
        if (document) {
          secrets.storeBedrockCredentials(JSON.stringify(document));
          if (document.authType === 'accessKeys') {
            delete stripped.accessKeyId;
            if (!isNonEmptyString(stripped.accessKeyIdPrefix)) {
              stripped.accessKeyIdPrefix = `${String(document.accessKeyId).slice(0, 8)}...`;
            }
          } else if (document.authType === 'apiKey' && !isNonEmptyString(stripped.apiKeyPrefix)) {
            stripped.apiKeyPrefix = `${String(document.apiKey).slice(0, 8)}...`;
          }
          log.info(`[LegacyImport] ${providerId}: routed bedrock credentials into secure storage`);
        } else {
          log.warn(
            `[LegacyImport] ${providerId}: stripped bedrock credential material with no complete document to route`,
          );
        }
      } else if (credentialsType === 'vertex') {
        const document = buildLegacyVertexDocument(stripped, materials);
        if (document) {
          // Desktop `vertex:save` parity: the whole document rides the
          // standard api-key bucket under 'vertex' (parsed back by
          // provider.fetchModels / getVertexCredentials equivalents).
          secrets.storeApiKey('vertex', JSON.stringify(document));
          log.info(`[LegacyImport] ${providerId}: routed vertex credentials into secure storage`);
        } else {
          log.warn(
            `[LegacyImport] ${providerId}: stripped vertex credential material with no complete document to route`,
          );
        }
      } else {
        const apiKeyMaterial = materials.find(
          (m) => m.field === 'apiKey' && isNonEmptyString(m.value),
        );
        if (apiKeyMaterial) {
          const key = apiKeyMaterial.value as string;
          secrets.storeApiKey(providerId, key);
          if (!isNonEmptyString(stripped.keyPrefix)) {
            stripped.keyPrefix = key.slice(0, 4);
          }
          log.info(`[LegacyImport] ${providerId}: routed apiKey credential into secure storage`);
        } else {
          log.warn(
            `[LegacyImport] ${providerId}: ${materials.length} credential-shaped field(s) of type "${credentialsType}" stripped with no secure-storage routing — re-enter them in the app to complete setup`,
          );
        }
      }
    }

    return { credentialsType, blob: JSON.stringify(stripped) };
  }

  // Variant shape: the credentials value is the raw plaintext key itself
  // (a provider → plaintext-key map entry). Same routing as the classic
  // apiKey field; the ledger gets a masked display blob instead.
  if (isNonEmptyString(credentials)) {
    const alreadyStored = secrets.getApiKey(providerId) !== null;
    if (!alreadyStored) {
      secrets.storeApiKey(providerId, credentials);
    }
    const effective = alreadyStored ? (secrets.getApiKey(providerId) ?? credentials) : credentials;
    const blob = { type: 'api_key', keyPrefix: effective.slice(0, 4) };
    log.info(`[LegacyImport] ${providerId}: routed raw-string credentials into secure storage`);
    return { credentialsType: 'api_key', blob: JSON.stringify(blob) };
  }

  // Null / non-object credentials: keep the historical byte-for-byte shape
  // ('{}' blob, 'api_key' fallback) — nothing to route or strip.
  return { credentialsType: 'api_key', blob: JSON.stringify({}) };
}

function importProviderSettings(
  db: Database,
  secrets: LegacyImportSecretSink,
  providerSettingsPath: string,
): void {
  const legacy = readJsonOrEmpty(providerSettingsPath);
  if (Object.keys(legacy).length === 0) {
    log.info(`[LegacyImport] No provider-settings to import (${providerSettingsPath})`);
    return;
  }
  try {
    db.prepare(
      `UPDATE provider_meta SET
        active_provider_id = ?,
        debug_mode = ?
      WHERE id = 1`,
    ).run((legacy.activeProviderId as string | null) ?? null, legacy.debugMode ? 1 : 0);

    const connectedProviders = legacy.connectedProviders as
      | Record<string, Record<string, unknown>>
      | null
      | undefined;

    if (connectedProviders) {
      const insertProvider = db.prepare(
        `INSERT OR IGNORE INTO providers
          (provider_id, connection_status, selected_model_id, credentials_type, credentials_data, last_connected_at, available_models)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [providerId, provider] of Object.entries(connectedProviders)) {
        if (!provider) {
          continue;
        }
        const { credentialsType, blob } = routeAndStripLegacyCredentials(
          providerId,
          provider.credentials,
          secrets,
        );
        insertProvider.run(
          providerId,
          (provider.connectionStatus as string) || 'disconnected',
          (provider.selectedModelId as string) ?? null,
          credentialsType,
          blob,
          (provider.lastConnectedAt as string) ?? null,
          JSON.stringify(provider.availableModels ?? null),
        );
      }
    }
    log.info('[LegacyImport] Provider settings imported');
  } catch (err) {
    log.error(`[LegacyImport] Failed to import provider-settings: ${String(err)}`);
  }
}

function importTaskHistory(db: Database, taskHistoryPath: string): void {
  const legacy = readJsonOrEmpty(taskHistoryPath);
  if (Object.keys(legacy).length === 0) {
    log.info(`[LegacyImport] No task-history to import (${taskHistoryPath})`);
    return;
  }
  const tasks = legacy.tasks as Array<Record<string, unknown>> | null | undefined;
  if (!tasks || tasks.length === 0) {
    log.info('[LegacyImport] No tasks to import');
    return;
  }
  try {
    const insertTask = db.prepare(
      `INSERT OR IGNORE INTO tasks
        (id, prompt, summary, status, session_id, created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMessage = db.prepare(
      `INSERT OR IGNORE INTO task_messages
        (id, task_id, type, content, tool_name, tool_input, timestamp, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAttachment = db.prepare(
      `INSERT OR IGNORE INTO task_attachments
        (message_id, type, data, label)
      VALUES (?, ?, ?, ?)`,
    );

    let imported = 0;
    for (const task of tasks) {
      const result = insertTask.run(
        task.id as string,
        task.prompt as string,
        (task.summary as string) ?? null,
        task.status as string,
        (task.sessionId as string) ?? null,
        task.createdAt as string,
        (task.startedAt as string) ?? null,
        (task.completedAt as string) ?? null,
      );
      if (result.changes > 0) {
        imported++;
        const messages = task.messages as Array<Record<string, unknown>> | null | undefined;
        if (messages) {
          let sortOrder = 0;
          for (const msg of messages) {
            insertMessage.run(
              msg.id as string,
              task.id as string,
              msg.type as string,
              msg.content as string,
              (msg.toolName as string) ?? null,
              msg.toolInput ? JSON.stringify(msg.toolInput) : null,
              msg.timestamp as string,
              sortOrder++,
            );
            const attachments = msg.attachments as Array<Record<string, unknown>> | null;
            if (attachments) {
              for (const att of attachments) {
                insertAttachment.run(
                  msg.id as string,
                  att.type as string,
                  att.data as string,
                  (att.label as string) ?? null,
                );
              }
            }
          }
        }
      }
    }
    log.info(
      `[LegacyImport] Imported ${imported} new tasks (${tasks.length - imported} already existed)`,
    );
  } catch (err) {
    log.error(`[LegacyImport] Failed to import task-history: ${String(err)}`);
  }
}

export class LegacyImportService {
  /**
   * `secrets` is the secure-storage seam (structurally `SecretsService`):
   * every credential entry the legacy blob carries is routed HERE and
   * stripped from the SQLite settings blob (audit §18.3.1 root fix).
   */
  constructor(
    private readonly db: Database,
    private readonly secrets: LegacyImportSecretSink,
  ) {}

  /**
   * Run the legacy electron-store import against the paths provided. Safe to
   * call repeatedly — subsequent calls are no-ops once `schema_meta` records
   * the completion flag, or when the main DB already has user data.
   */
  importElectronStoreIfNeeded(paths: LegacyImportPaths): LegacyImportResult {
    if (wasAttempted(this.db)) {
      log.info('[LegacyImport] Already completed; skipping');
      return { imported: false, reason: 'already-imported' };
    }
    if (hasExistingUserData(this.db)) {
      log.info('[LegacyImport] Main DB already has user data; marking complete without running');
      markComplete(this.db);
      return { imported: false, reason: 'existing-data' };
    }

    log.info('[LegacyImport] Starting legacy electron-store import');
    importAppSettings(this.db, paths.appSettingsPath);
    importProviderSettings(this.db, this.secrets, paths.providerSettingsPath);
    importTaskHistory(this.db, paths.taskHistoryPath);
    markComplete(this.db);
    log.info('[LegacyImport] Legacy import complete');

    return { imported: true, reason: 'completed' };
  }
}
