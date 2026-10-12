import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import fs from 'fs';
import puppeteer, {
  type Browser as PuppeteerBrowser,
  type BrowserContext as PuppeteerBrowserContext,
  type ElementHandle as PuppeteerElementHandle,
  type Page as PuppeteerPage,
} from 'puppeteer-core';

type AnyRecord = Record<string, any>;

const wrappedPages = new WeakMap<object, any>();
const wrappedContexts = new WeakMap<object, any>();

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firefoxExecutable(): string {
  const configured = process.env.FIREFOX_BIN;
  const candidates = [
    configured,
    '/snap/bin/firefox',
    '/usr/bin/firefox',
    '/usr/bin/firefox-esr',
  ].filter(Boolean) as string[];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      '[FirefoxBiDi] Firefox executable not found. Set FIREFOX_BIN or install Firefox.',
    );
  }
  return found;
}

function firefoxProfileDir(): string {
  if (process.env.ACCOMPLISH_FIREFOX_PROFILE) {
    return process.env.ACCOMPLISH_FIREFOX_PROFILE;
  }

  // Snap Firefox cannot reliably access arbitrary /tmp paths due to confinement.
  // Keep Accomplish's dedicated automation profile inside the user's home.
  const snapCommon = path.join(os.homedir(), 'snap', 'firefox', 'common');
  if (fs.existsSync(path.join(os.homedir(), 'snap', 'firefox'))) {
    return path.join(snapCommon, 'accomplish-bidi-profile');
  }
  return path.join(os.homedir(), '.config', 'Accomplish', 'firefox-bidi-profile');
}

class BidiCdpSessionShim extends EventEmitter {
  private screencastTimer: NodeJS.Timeout | null = null;
  private frameId = 1;

  constructor(private readonly page: any) {
    super();
  }

  async send(method: string, params: AnyRecord = {}): Promise<any> {
    switch (method) {
      case 'Input.insertText':
        await this.page.keyboard.type(String(params.text ?? ''));
        return {};

      case 'Target.getTargetInfo':
        return {
          targetInfo: {
            targetId: this.page.__accomplishTargetId ?? 'firefox-bidi-page',
            type: 'page',
            title: await this.page.title().catch(() => ''),
            url: this.page.url(),
            attached: true,
          },
        };

      case 'Browser.getWindowForTarget':
        return { windowId: 1, bounds: { windowState: 'normal' } };

      case 'Browser.setWindowBounds':
        // Firefox BiDi does not expose the Chromium window API used here.
        // Window management is cosmetic for Accomplish, so treat it as best-effort.
        return {};

      case 'Page.stopScreencast':
        this.stopScreencast();
        return {};

      case 'Page.startScreencast':
        this.startScreencast();
        return {};

      case 'Page.screencastFrameAck':
        return {};

      default:
        throw new Error(`[FirefoxBiDi] Unsupported CDP compatibility call: ${method}`);
    }
  }

  private startScreencast(): void {
    this.stopScreencast();
    this.screencastTimer = setInterval(async () => {
      try {
        if (this.page.isClosed()) {
          this.stopScreencast();
          return;
        }
        const shot = await this.page.screenshot({
          type: 'jpeg',
          quality: 60,
          fullPage: false,
        });
        const buffer = Buffer.isBuffer(shot) ? shot : Buffer.from(shot);
        this.emit('Page.screencastFrame', {
          data: buffer.toString('base64'),
          metadata: {
            offsetTop: 0,
            pageScaleFactor: 1,
            deviceWidth: this.page.viewportSize()?.width ?? 1280,
            deviceHeight: this.page.viewportSize()?.height ?? 720,
            scrollOffsetX: 0,
            scrollOffsetY: 0,
            timestamp: Date.now() / 1000,
          },
          sessionId: this.frameId++,
        });
      } catch {
        // Preview frames are best effort. Automation should continue if a
        // screenshot is temporarily unavailable during navigation.
      }
    }, 700);
  }

  private stopScreencast(): void {
    if (this.screencastTimer) {
      clearInterval(this.screencastTimer);
      this.screencastTimer = null;
    }
  }

  async detach(): Promise<void> {
    this.stopScreencast();
    this.removeAllListeners();
  }
}

function wrapElement(raw: PuppeteerElementHandle, page: any): any {
  if (!raw) return raw;

  return new Proxy(raw as any, {
    get(target, prop, receiver) {
      if (prop === 'fill') {
        return async (text: string) => {
          try {
            await target.click({ clickCount: 3 });
          } catch {
            await target.click().catch(() => {});
          }
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await page.keyboard.type(text);
        };
      }

      if (prop === 'scrollIntoViewIfNeeded') {
        return async () => {
          if (typeof target.scrollIntoView === 'function') {
            await target.scrollIntoView();
          } else {
            await target.evaluate((el: Element) =>
              el.scrollIntoView({ block: 'center', inline: 'center' }),
            );
          }
        };
      }

      if (prop === 'selectOption') {
        return async (values: any) => {
          const vals = Array.isArray(values) ? values : [values];
          const normalized = vals.map((v) =>
            typeof v === 'string' ? v : String(v?.value ?? v?.label ?? v),
          );
          return target.select(...normalized);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function wrapPage(raw: PuppeteerPage, context: any, targetId: string): any {
  const cached = wrappedPages.get(raw as any);
  if (cached) return cached;

  let proxy: any;

  proxy = new Proxy(raw as any, {
    get(target, prop, receiver) {
      if (prop === '__rawPuppeteerPage') return raw;
      if (prop === '__accomplishTargetId') return targetId;
      if (prop === 'context') return () => context;
      if (prop === 'viewportSize') return () => target.viewport();
      if (prop === 'waitForTimeout') return (ms: number) => wait(ms);

      if (prop === 'waitForLoadState') {
        return async (state = 'load', options: AnyRecord = {}) => {
          const timeout = Number(options.timeout ?? 30000);
          if (state === 'networkidle' || state === 'networkidle0') {
            if (typeof target.waitForNetworkIdle === 'function') {
              return target.waitForNetworkIdle({ timeout }).catch(() => undefined);
            }
          }
          return target
            .waitForFunction(
              () => document.readyState === 'complete' || document.readyState === 'interactive',
              { timeout },
            )
            .catch(() => undefined);
        };
      }

      if (prop === 'setViewportSize') {
        return (viewport: { width: number; height: number }) => target.setViewport(viewport);
      }

      if (prop === 'selectOption') {
        return async (selector: string, values: any) => {
          const vals = Array.isArray(values) ? values : [values];
          const normalized = vals.map((v) =>
            typeof v === 'string' ? v : String(v?.value ?? v?.label ?? v),
          );
          return target.select(selector, ...normalized);
        };
      }

      if (prop === 'screenshot') {
        return async (options: AnyRecord = {}) => {
          const opts = { ...options };
          delete opts.scale;
          const result = await target.screenshot(opts as any);
          return Buffer.isBuffer(result) ? result : Buffer.from(result);
        };
      }

      if (prop === 'waitForSelector') {
        return async (...args: any[]) => {
          const handle = await (target.waitForSelector as any)(...args);
          return handle ? wrapElement(handle, proxy) : handle;
        };
      }

      if (prop === '$') {
        return async (...args: any[]) => {
          const handle = await (target.$ as any)(...args);
          return handle ? wrapElement(handle, proxy) : handle;
        };
      }

      if (prop === '$$') {
        return async (...args: any[]) => {
          const handles = await (target.$$ as any)(...args);
          return handles.map((handle: any) => wrapElement(handle, proxy));
        };
      }

      if (prop === 'evaluateHandle') {
        return async (...args: any[]) => {
          const handle = await (target.evaluateHandle as any)(...args);
          if (handle && typeof handle.asElement === 'function') {
            const element = handle.asElement();
            if (element) return wrapElement(element, proxy);
          }
          return handle;
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  wrappedPages.set(raw as any, proxy);
  return proxy;
}

function wrapContext(raw: PuppeteerBrowserContext): any {
  const cached = wrappedContexts.get(raw as any);
  if (cached) return cached;

  let nextTarget = 1;
  const targetIds = new WeakMap<object, string>();
  let proxy: any;

  const wrap = (page: PuppeteerPage) => {
    let id = targetIds.get(page as any);
    if (!id) {
      id = `firefox-bidi-${nextTarget++}`;
      targetIds.set(page as any, id);
    }
    return wrapPage(page, proxy, id);
  };

  proxy = {
    async pages() {
      return (await raw.pages()).map(wrap);
    },

    async newPage() {
      return wrap(await raw.newPage());
    },

    async newCDPSession(page: any) {
      return new BidiCdpSessionShim(page);
    },

    async close() {
      return raw.close();
    },

    __rawPuppeteerContext: raw,
  };

  wrappedContexts.set(raw as any, proxy);
  return proxy;
}

function wrapBrowser(raw: PuppeteerBrowser): any {
  const contextMap = new WeakMap<object, any>();

  const contextFor = (ctx: PuppeteerBrowserContext) => {
    let wrapped = contextMap.get(ctx as any);
    if (!wrapped) {
      wrapped = wrapContext(ctx);
      contextMap.set(ctx as any, wrapped);
    }
    return wrapped;
  };

  return {
    isConnected() {
      const connected = (raw as any).connected;
      return typeof connected === 'boolean' ? connected : true;
    },

    contexts() {
      const contexts =
        typeof (raw as any).browserContexts === 'function'
          ? (raw as any).browserContexts()
          : [(raw as any).defaultBrowserContext()];
      return contexts.map(contextFor);
    },

    async newContext() {
      const ctx =
        typeof (raw as any).createBrowserContext === 'function'
          ? await (raw as any).createBrowserContext()
          : (raw as any).defaultBrowserContext();
      return contextFor(ctx);
    },

    async close() {
      await raw.close();
    },

    __rawPuppeteerBrowser: raw,
  };
}

let singletonBrowser: any = null;

export function isFirefoxBidiEnabled(): boolean {
  return process.env.ACCOMPLISH_BROWSER === 'firefox-bidi';
}

export async function launchFirefoxBidiBrowser(): Promise<any> {
  if (singletonBrowser?.isConnected?.()) return singletonBrowser;

  const executablePath = firefoxExecutable();
  const userDataDir = firefoxProfileDir();
  fs.mkdirSync(userDataDir, { recursive: true });

  console.error(`[FirefoxBiDi] launching ${executablePath}`);
  console.error(`[FirefoxBiDi] profile ${userDataDir}`);

  const raw = await puppeteer.launch({
    browser: 'firefox',
    protocol: 'webDriverBiDi',
    executablePath,
    userDataDir,
    headless: false,
    acceptInsecureCerts: true,
    defaultViewport: { width: 1280, height: 800 },
  } as any);

  raw.on('disconnected', () => {
    singletonBrowser = null;
  });

  singletonBrowser = wrapBrowser(raw);
  return singletonBrowser;
}
