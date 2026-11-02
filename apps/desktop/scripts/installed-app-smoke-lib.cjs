'use strict';

/**
 * Testable core of installed-app-smoke.cjs — profile ownership + arch probes.
 *
 * Cleanup safety contract (M3a review):
 *   - every run uses a UNIQUE generated profile name; a `--profile` override
 *     is deliberately NOT exposed on the CLI so cleanup can never be aimed at
 *     a pre-existing directory;
 *   - a candidate whose directory already exists is discarded (never
 *     reused/deleted) and the generator retries;
 *   - ownership is recorded as "this run created the dir" only when the dir
 *     did not exist before the launch; cleanup deletes exclusively owned,
 *     existing directories;
 *   - if ownership is uncertain the cleanup step is refused, leaving
 *     evidence files behind instead of guessing.
 */

const fs = require('fs');
const path = require('path');

const PROFILE_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/i;
const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

class ProfileSelectionError extends Error {}

/** True when `name` is a safe override profile identifier. */
function isValidProfileName(name) {
  return (
    PROFILE_RE.test(name) &&
    !name.includes('..') &&
    !/[.\-_]$/.test(name) &&
    name.toLowerCase() !== 'accomplish' &&
    !WINDOWS_RESERVED_NAMES.has(name.toLowerCase())
  );
}

/**
 * Generated acceptance profile name: `acceptance-YYYYMMDDHHMMSSF`. Includes
 * the process id so two concurrent smoke runs on one machine can never
 * collide, and the milliseconds for unique dir derivation.
 */
function generateProfileName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const name =
    `acceptance-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(process.pid + now.getUTCMilliseconds())}`.slice(
      0,
      48,
    );
  if (!isValidProfileName(name)) {
    throw new ProfileSelectionError(`generated profile name failed validation: ${name}`);
  }
  return name;
}

/**
 * Pick a profile whose data directory does not yet exist. At least one
 * existing directory must never be touched: an existing candidate is
 * skipped, and after `maxTries` distinct collisions this fails instead of
 * reusing anything.
 */
function findUniqueProfileDataDir(appDataRootPath, existsFn = fs.existsSync, maxTries = 64) {
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const profileName = generateProfileName(new Date(Date.now() + attempt));
    const dataDirName = `Accomplish-${profileName}`;
    const dataDir = path.join(appDataRootPath, dataDirName);
    if (!existsFn(dataDir)) {
      return { profileName, dataDir };
    }
  }
  throw new ProfileSelectionError(
    `Could not generate a unique profile directory after ${maxTries} attempts under ${appDataRootPath}`,
  );
}

/**
 * Delete permission for the run's profile directory. Deletion happens only
 * when the run created it (the directory was absent pre-launch). If ownership
 * cannot be established the caller must leave the directory untouched.
 */
function resolveCleanupOwnership(profileExistedAtStart) {
  if (profileExistedAtStart) {
    return { mayDelete: false, reason: 'directory existed before this run; ownership uncertain' };
  }
  return { mayDelete: true, reason: 'directory was created by this run' };
}

/** Remove `dataDir` only when ownership was proven. Returns {deleted, reason}. */
function deleteOwnedProfileDataDir(dataDir, profileExistedAtStart, rmFn) {
  const ownership = resolveCleanupOwnership(profileExistedAtStart);
  if (!ownership.mayDelete) {
    return { deleted: false, reason: ownership.reason };
  }
  if (!fs.existsSync(dataDir)) {
    return { deleted: false, reason: 'nothing to remove (directory absent)' };
  }
  try {
    rmFn(dataDir, { recursive: true, force: true });
    return { deleted: true, reason: 'owned directory removed' };
  } catch (err) {
    return { deleted: false, reason: `removal failed (inconclusive): ${err}` };
  }
}

/* ------------------------------------------------------------------ *
 * Binary architecture probes (PE machine / Mach-O cputype)
 * ------------------------------------------------------------------ */

/** 'arm64' | 'x64' | 'x86' | 'unknown-<hex>' | null for a PE file. */
function readPeMachine(filePath) {
  const header = readHeader(filePath, 0x400);
  if (!header || header.length < 0x40 || header.readUInt16BE(0) !== 0x4d5a) {
    return null;
  }
  const peOffset = header.readInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 6 > header.length) {
    return null;
  }
  const machine = header.readUInt16LE(peOffset + 4);
  if (machine === 0xaa64) {
    return 'arm64';
  }
  if (machine === 0x8664) {
    return 'x64';
  }
  if (machine === 0x014c) {
    return 'x86';
  }
  return `unknown-0x${machine.toString(16)}`;
}

/** 'arm64' | 'x64' | 'x86' | 'fat' (universal) | null for a Mach-O file. */
function readMachOCpuType(filePath) {
  const header = readHeader(filePath, 0x20);
  if (!header || header.length < 0x10) {
    return null;
  }
  const magicLE = header.readUInt32LE(0);
  if (magicLE === 0xbebafeca) {
    return 'fat';
  }
  if (magicLE !== 0xfeedface && magicLE !== 0xfeedfacf) {
    return null;
  }
  const cputype = header.readUInt32LE(4);
  if (cputype === 0x0100000c) {
    return 'arm64';
  }
  if (cputype === 0x01000007) {
    return 'x64';
  }
  if (cputype === 0x00000007) {
    return 'x86';
  }
  return `unknown-0x${cputype.toString(16)}`;
}

function readHeader(filePath, size) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(fd, buffer, 0, size, 0);
    return read === size ? buffer : buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  isValidProfileName,
  generateProfileName,
  findUniqueProfileDataDir,
  resolveCleanupOwnership,
  deleteOwnedProfileDataDir,
  ProfileSelectionError,
  PROFILE_RE,
  WINDOWS_RESERVED_NAMES,
  readPeMachine,
  readMachOCpuType,
};
