/**
 * Side-effect module: bootstraps the gateway API before any application
 * module (router, stores) evaluates. Must be the FIRST import in
 * main.tsx — ESM evaluates a module's imports in order, so this body runs
 * before router.tsx (which constructs the HashRouter and would treat the
 * '#token=...' fragment as a route path).
 */

import { bootstrapGatewayApi } from './gateway-bootstrap';

bootstrapGatewayApi();
