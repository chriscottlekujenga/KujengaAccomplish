export {
  ensureAzureFoundryProxy,
  stopAzureFoundryProxy,
  isAzureFoundryProxyRunning,
  getAzureFoundryProxyBindAddress,
  transformRequestBody as transformAzureFoundryRequestBody,
  PROXY_TOKEN_HEADER,
} from './azure-foundry-proxy.js';
export type { AzureFoundryProxyInfo } from './azure-foundry-proxy.js';

export {
  ensureMoonshotProxy,
  stopMoonshotProxy,
  isMoonshotProxyRunning,
  getMoonshotProxyBindAddress,
  transformMoonshotRequestBody,
} from './moonshot-proxy.js';
export type { MoonshotProxyInfo } from './moonshot-proxy.js';

export {
  getAzureEntraToken,
  clearAzureTokenCache,
  hasValidToken as hasValidAzureToken,
  getTokenExpiry as getAzureTokenExpiry,
} from './azure-token-manager.js';
