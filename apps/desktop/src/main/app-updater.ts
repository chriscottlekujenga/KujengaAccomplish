import { app } from 'electron';
import fs from 'fs';
import path from 'path';
// electron-updater is published as CommonJS. Import it as the default module so
// Electron's ESM loader can access its exports in packaged builds.
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
import { getLogCollector } from './logging';

let started = false;

function log(level: 'INFO' | 'WARN', message: string, data?: Record<string, unknown>) {
  try {
    getLogCollector()?.log?.(level, 'main', message, data);
  } catch {
    // Updates must never prevent the desktop app from starting.
  }
}

/** Checks the KujengaAccomplish GitHub release feed after startup. */
export function startAutoUpdater(): void {
  if (started || !app.isPackaged || process.env.ACCOMPLISH_DISABLE_AUTO_UPDATE === '1') return;
  // A locally unpacked Windows build has no update metadata. Skip the release
  // check rather than creating a misleading startup error.
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    log('INFO', '[Updater] Skipping update check for local unpacked build');
    return;
  }
  started = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => log('INFO', '[Updater] Checking for a release'));
  autoUpdater.on('update-available', (info) => log('INFO', '[Updater] Downloading update', { version: info.version }));
  autoUpdater.on('update-not-available', () => log('INFO', '[Updater] App is up to date'));
  autoUpdater.on('update-downloaded', (info) => log('INFO', '[Updater] Update will install when the app is closed', { version: info.version }));
  autoUpdater.on('error', (error) => log('WARN', '[Updater] Update check failed; continuing normally', { error: String(error) }));
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error) =>
      log('WARN', '[Updater] Could not check for updates', { error: String(error) }),
    );
  }, 15_000);
}
