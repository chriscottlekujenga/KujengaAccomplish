/**
 * Sensitive-surface blocklist for the linux-desktop MCP tool (lean port of the
 * upstream desktop-control blocklist removed at git 05a25bc).
 *
 * Entries are matched case-insensitively as substrings against desktop-file
 * basenames, window titles, and application names. Password managers and
 * credential/security surfaces are blocked so the agent never enumerates or
 * drives them, even when the user approved the surrounding task.
 */
const DESKTOP_BLOCKLIST_ENTRIES: readonly string[] = [
  // Password managers
  '1Password',
  'Bitwarden',
  'LastPass',
  'KeePass',
  'Dashlane',
  // Credential / security surfaces
  'Keychain Access',
  'Credential Manager',
  'Windows Security',
  'Registry Editor',
];

/**
 * Return the first blocklist entry that appears as a case-insensitive
 * substring of `text`, or null when nothing matched.
 */
export function findBlocklistMatch(text: string): string | null {
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  for (const entry of DESKTOP_BLOCKLIST_ENTRIES) {
    if (lower.includes(entry.toLowerCase())) {
      return entry;
    }
  }
  return null;
}
