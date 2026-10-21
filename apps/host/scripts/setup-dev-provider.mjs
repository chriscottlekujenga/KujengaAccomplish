#!/usr/bin/env node
/**
 * Dev tool — configure the ISOLATED daemon's default provider for
 * Firefox-shell verification. Speaks to the daemon's Unix socket directly
 * (operator-side setup), so the gateway's browser-facing allowlist stays
 * minimal. Credentials are stored ONLY in the isolated data dir.
 *
 * Two provider modes:
 *
 *   --provider ollama  (local Ollama — no API key needed)
 *     node scripts/setup-dev-provider.mjs --provider ollama \
 *       [--server-url http://127.0.0.1:11434] [--model glm-5.3:cloud] \
 *       [--data-dir ~/.local/share/Accomplish]
 *
 *   --provider custom  (default — any OpenAI-compatible endpoint)
 *     node scripts/setup-dev-provider.mjs --api-key <KEY> \
 *       [--base-url https://ollama.com/v1] [--model glm-5.3:cloud]
 */

import { createSocketTransport, DaemonClient } from '@accomplish_ai/agent-core/desktop-main';

function parseArgs(argv) {
  const args = {
    dataDir: null,
    apiKey: null,
    baseUrl: 'https://ollama.com/v1',
    model: 'glm-5.3:cloud',
    provider: 'custom',
    serverUrl: 'http://127.0.0.1:11434',
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--api-key' && argv[i + 1]) {
      args.apiKey = argv[i + 1];
      i++;
    } else if (argv[i] === '--data-dir' && argv[i + 1]) {
      args.dataDir = argv[i + 1];
      i++;
    } else if (argv[i] === '--base-url' && argv[i + 1]) {
      args.baseUrl = argv[i + 1];
      i++;
    } else if (argv[i] === '--model' && argv[i + 1]) {
      args.model = argv[i + 1];
      i++;
    } else if (argv[i] === '--provider' && argv[i + 1]) {
      args.provider = argv[i + 1];
      i++;
    } else if (argv[i] === '--server-url' && argv[i + 1]) {
      args.serverUrl = argv[i + 1];
      i++;
    }
  }
  return args;
}

const home = process.env.HOME || '/home/chris';
const args = parseArgs(process.argv);

if (args.provider === 'custom' && !args.apiKey) {
  console.error(
    'custom provider requires --api-key. For local Ollama, use: --provider ollama [--server-url http://127.0.0.1:11434]',
  );
  process.exit(1);
}

const dataDir = args.dataDir || `${home}/.local/share/Accomplish`;
const modelId = `${args.provider}/${args.model}`;

const transport = await createSocketTransport({ dataDir, connectTimeout: 5000 });
const client = new DaemonClient({ transport });

if (args.provider === 'ollama') {
  // Local Ollama needs no key — the daemon builds the OpenAI-compatible
  // provider from {type: 'ollama', serverUrl} (buildOllamaConfig).
  await client.call('provider.setConnected', {
    providerId: 'ollama',
    provider: {
      providerId: 'ollama',
      connectionStatus: 'connected',
      selectedModelId: modelId,
      credentials: { type: 'ollama', serverUrl: args.serverUrl },
      lastConnectedAt: new Date().toISOString(),
      availableModels: [{ id: modelId, name: args.model, toolSupport: 'supported' }],
    },
  });
} else {
  await client.call('secrets.storeApiKey', { provider: 'custom', apiKey: args.apiKey });
  await client.call('provider.setConnected', {
    providerId: 'custom',
    provider: {
      providerId: 'custom',
      connectionStatus: 'connected',
      selectedModelId: modelId,
      credentials: {
        type: 'custom',
        baseUrl: args.baseUrl,
        modelName: args.model,
        hasApiKey: true,
        keyPrefix: args.apiKey.slice(0, 4),
      },
      lastConnectedAt: new Date().toISOString(),
      availableModels: [{ id: modelId, name: args.model, toolSupport: 'supported' }],
    },
  });
}

await client.call('settings.setSelectedModel', {
  model: { provider: args.provider, model: modelId },
});
await client.call('provider.setActive', { providerId: args.provider });

const selected = await client.call('settings.getSelectedModel');
console.log(`[setup-dev-provider] ${args.provider} provider configured.`);
console.log('[setup-dev-provider] dataDir:  ', dataDir);
console.log('[setup-dev-provider] selected:  ', JSON.stringify(selected));
client.close();
