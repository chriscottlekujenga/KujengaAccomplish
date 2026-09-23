import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
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
