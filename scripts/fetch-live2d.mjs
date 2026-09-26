#!/usr/bin/env node
// Fetches the Live2D Cubism SDK for Web pieces needed to build the app:
//   - Cubism Core (Live2D Proprietary Software License, "Redistributable Code")
//   - Cubism Web Framework 5-r.3 (Live2D Open Software License)
// Neither is committed to this repository, like in the original RealAmadeus project.
//
// The Core build is pinned: the Kurisu model is a moc3 v5 file and the Framework
// 5-r.3 only uses Core APIs present in this build. The file is verified by SHA-256
// so the same bytes end up in every APK.
//
// Usage: node scripts/fetch-live2d.mjs            (downloads what is missing)
//        LIVE2D_CORE_PATH=/path/to/live2dcubismcore.min.js node scripts/fetch-live2d.mjs
//        (uses a Core you downloaded yourself from https://www.live2d.com/sdk/download/web/)

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const VENDOR = path.join(WEB, 'vendor');
const CORE_DIR = path.join(VENDOR, 'core');
const PUBLIC_LIB = path.join(WEB, 'public', 'lib');
const FRAMEWORK_DIR = path.join(VENDOR, 'CubismWebFramework');

const FRAMEWORK_REPO = 'https://github.com/Live2D/CubismWebFramework.git';
const FRAMEWORK_TAG = '5-r.3';
const FRAMEWORK_COMMIT = '01e64ba44fc29e5e7206f0c397ee532edf824ee9';

const CORE_FILES = {
  'live2dcubismcore.min.js': '942783587666a3a1bddea93afd349e26f798ed19dcd7a52449d0ae3322fcff7c',
  'live2dcubismcore.d.ts': 'fa914858b76cf0589be2a120dfbd6733951f725f79139342d4908af05c3ed2dd',
  'LICENSE.md': 'b81e37048010ef1d336106151201a0323c3309cae44aecdedf57831fe88fa991',
};

// Two independent mirrors of the same official Core release (identical bytes).
const CORE_GITHUB_BASE =
  'https://raw.githubusercontent.com/Open-LLM-VTuber/Open-LLM-VTuber-Web/d176e7df2366952e3bacbf12cf9a8b18a4315932/src/renderer/WebSDK/Core/';
const CORE_NPM_TARBALL = 'https://registry.npmjs.org/@hazart-pkg/live2d-core/-/live2d-core-1.0.1.tgz';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function untarFile(tgz, wanted) {
  const tar = zlib.gunzipSync(tgz);
  for (let off = 0; off + 512 <= tar.length; ) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8) || 0;
    const start = off + 512;
    if (name === wanted) return tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

function isValid(file, expected) {
  return fs.existsSync(file) && sha256(fs.readFileSync(file)) === expected;
}

async function fetchCore() {
  fs.mkdirSync(CORE_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_LIB, { recursive: true });

  const custom = process.env.LIVE2D_CORE_PATH;
  if (custom) {
    console.warn(`[live2d] Using Core from LIVE2D_CORE_PATH=${custom} (not hash-checked).`);
    fs.copyFileSync(custom, path.join(CORE_DIR, 'live2dcubismcore.min.js'));
  }

  let tarball = null;
  for (const [name, hash] of Object.entries(CORE_FILES)) {
    const dest = path.join(CORE_DIR, name);
    if (custom && name === 'live2dcubismcore.min.js') continue;
    if (isValid(dest, hash)) continue;

    let data = null;
    try {
      data = await download(CORE_GITHUB_BASE + name);
      if (sha256(data) !== hash) data = null;
    } catch (e) {
      console.warn(`[live2d] GitHub mirror failed for ${name}: ${e.message}`);
    }
    if (!data) {
      tarball ??= await download(CORE_NPM_TARBALL);
      data = untarFile(tarball, `package/${name}`);
      if (!data || sha256(data) !== hash) {
        throw new Error(`[live2d] Could not obtain a verified copy of ${name}.`);
      }
    }
    fs.writeFileSync(dest, data);
    console.log(`[live2d] ${name} OK`);
  }
  fs.copyFileSync(path.join(CORE_DIR, 'live2dcubismcore.min.js'), path.join(PUBLIC_LIB, 'live2dcubismcore.min.js'));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

function fetchFramework() {
  if (fs.existsSync(path.join(FRAMEWORK_DIR, '.git'))) {
    try {
      if (git(['rev-parse', 'HEAD'], FRAMEWORK_DIR) === FRAMEWORK_COMMIT) {
        console.log('[live2d] Framework already present');
        return;
      }
    } catch {
      // fall through and re-clone
    }
    fs.rmSync(FRAMEWORK_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(VENDOR, { recursive: true });
  git(['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', FRAMEWORK_TAG, FRAMEWORK_REPO, FRAMEWORK_DIR], VENDOR);
  const head = git(['rev-parse', 'HEAD'], FRAMEWORK_DIR);
  if (head !== FRAMEWORK_COMMIT) {
    throw new Error(`[live2d] Framework tag ${FRAMEWORK_TAG} points to ${head}, expected ${FRAMEWORK_COMMIT}`);
  }
  console.log(`[live2d] Framework ${FRAMEWORK_TAG} OK`);
}

await fetchCore();
fetchFramework();
