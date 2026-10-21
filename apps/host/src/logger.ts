/**
 * Minimal leveled logger for the host process.
 *
 * The host is a thin, debuggable shell — structured pino logging (like the
 * daemon) is overkill here. Everything goes to stdout/stderr with a `[host]`
 * prefix so `accomplish-host` output is greppable next to daemon logs.
 */

export interface HostLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

function format(msg: string, data?: Record<string, unknown>): string {
  if (data && Object.keys(data).length > 0) {
    return `${msg} ${JSON.stringify(data)}`;
  }
  return msg;
}

export function createConsoleLogger(prefix = '[host]'): HostLogger {
  return {
    debug: (msg, data) => {
      console.log(`${prefix} ${format(msg, data)}`);
    },
    info: (msg, data) => {
      console.log(`${prefix} ${format(msg, data)}`);
    },
    warn: (msg, data) => {
      console.warn(`${prefix} ${format(msg, data)}`);
    },
    error: (msg, data) => {
      console.error(`${prefix} ${format(msg, data)}`);
    },
  };
}

/** Silent logger for tests and for embedding the gateway in other tools. */
export const noopLogger: HostLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
