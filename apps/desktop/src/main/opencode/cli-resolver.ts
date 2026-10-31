import { app } from 'electron';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  resolveCliPath,
  isCliAvailable as coreIsCliAvailable,
  type CliResolverConfig,
} from '@accomplish_ai/agent-core/desktop-main';

function getCliResolverConfig(): CliResolverConfig {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  };
}

export function getOpenCodeCliPath(): { command: string; args: string[] } {
  const resolved = resolveCliPath(getCliResolverConfig());
  if (resolved) {
    return { command: resolved.cliPath, args: [] };
  }
  throw new Error('OpenCode CLI executable not found');
}

export function isOpenCodeBundled(): boolean {
  return coreIsCliAvailable(getCliResolverConfig());
}

export function isOpenCodeCliAvailable(): boolean {
  return coreIsCliAvailable(getCliResolverConfig());
}

export function getBundledOpenCodeVersion(): string | null {
  if (app.isPackaged) {
    try {
      const { command } = getOpenCodeCliPath();
      // Packaged layout: <resourcesPath>/app.asar.unpacked/node_modules/<pkg>/bin/opencode(.exe)
      // The package.json sits two levels above the binary. Deriving it from
      // the resolved path keeps this arch-agnostic (windows x64/arm64, darwin,
      // linux each ship a different package name).
      const packageJsonPath = path.join(path.dirname(path.dirname(command)), 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        return pkg.version;
      }
    } catch {
      // intentionally empty — fall through to the CLI probe below
    }
  }

  try {
    const { command } = getOpenCodeCliPath();
    // Use execFileSync (no shell) so installation paths that contain spaces
    // (e.g. "C:\Users\My Name\...") are passed directly to the OS without
    // cmd.exe quoting ambiguity.
    // See: https://github.com/accomplish-ai/accomplish/issues/596
    const output = execFileSync(command, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim();

    const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
    return versionMatch ? versionMatch[1] : output;
  } catch {
    return null;
  }
}
