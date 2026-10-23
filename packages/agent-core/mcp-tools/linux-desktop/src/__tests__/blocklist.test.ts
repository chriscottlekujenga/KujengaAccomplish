import { describe, it, expect } from 'vitest';
import { findBlocklistMatch } from '../blocklist.js';

describe('findBlocklistMatch', () => {
  it('matches password managers case-insensitively', () => {
    expect(findBlocklistMatch('1Password — Vault')).toBe('1Password');
    expect(findBlocklistMatch('Bitwarden — Vault')).toBe('Bitwarden');
    expect(findBlocklistMatch('bitwarden')).toBe('Bitwarden');
    expect(findBlocklistMatch('lastpass')).toBe('LastPass');
    expect(findBlocklistMatch('KeePassXC — password Database')).toBe('KeePass');
    expect(findBlocklistMatch('DASHLANE')).toBe('Dashlane');
  });

  it('matches credential and security surfaces', () => {
    expect(findBlocklistMatch('Keychain Access')).toBe('Keychain Access');
    expect(findBlocklistMatch('credential manager')).toBe('Credential Manager');
    expect(findBlocklistMatch('Windows Security')).toBe('Windows Security');
    expect(findBlocklistMatch('registry editor')).toBe('Registry Editor');
  });

  it('returns null for clean strings', () => {
    expect(findBlocklistMatch('Settings')).toBeNull();
    expect(findBlocklistMatch('Files — /home/chris')).toBeNull();
    expect(findBlocklistMatch('Firefox — Mozilla Support')).toBeNull();
    expect(findBlocklistMatch('')).toBeNull();
  });
});
