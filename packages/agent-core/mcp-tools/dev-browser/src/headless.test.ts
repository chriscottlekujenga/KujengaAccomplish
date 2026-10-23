import { describe, expect, it } from 'vitest';
import { hasGraphicalDisplay, resolveHeadlessFromEnv } from './headless.js';

describe('headless resolution', () => {
  it('explicit HEADLESS=true wins over a display', () => {
    expect(resolveHeadlessFromEnv({ HEADLESS: 'true', DISPLAY: ':0' })).toBe(true);
  });

  it('explicit HEADLESS=false wins over no display', () => {
    expect(resolveHeadlessFromEnv({ HEADLESS: 'false' })).toBe(false);
  });

  it('defaults to headless without any display variable (display-less daemon)', () => {
    expect(resolveHeadlessFromEnv({})).toBe(true);
  });

  it('defaults to headed when DISPLAY exists', () => {
    expect(resolveHeadlessFromEnv({ DISPLAY: ':0' })).toBe(false);
  });

  it('defaults to headed when WAYLAND_DISPLAY exists', () => {
    expect(resolveHeadlessFromEnv({ WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
  });

  it('hasGraphicalDisplay treats empty strings as absent', () => {
    expect(hasGraphicalDisplay({ DISPLAY: '', WAYLAND_DISPLAY: '' })).toBe(false);
  });

  it('explicit HEADLESS=true wins even without a display', () => {
    expect(resolveHeadlessFromEnv({ HEADLESS: 'true' })).toBe(true);
  });
});
