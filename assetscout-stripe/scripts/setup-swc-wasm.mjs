#!/usr/bin/env node
/**
 * Android / VSCodroid SWC fallback wiring — local build rig only.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `next@15.5.7` publishes no native SWC binary for android/arm64. The loader in
 * `next/dist/build/swc/index.js` knows this: `knownDefaultWasmFallbackTriples`
 * contains `aarch64-linux-android`, so Android is treated as an
 * "unsupported platform" and the loader tries the WASM build **first**
 * (`shouldLoadWasmFallbackFirst === true`).
 *
 * That first attempt is built from the *bare specifier string*:
 *
 *     await import(pathToFileURL('@next/swc-wasm-nodejs').toString())
 *                              ^ literal package name, used as a relative path
 *
 * `pathToFileURL('@next/swc-wasm-nodejs')` yields
 * `<projectRoot>/@next/swc-wasm-nodejs`, which never exists — so the attempt
 * fails with ERR_MODULE_NOT_FOUND **even though the package is installed** in
 * `node_modules`. (The second candidate, `@next/swc-wasm-web`, is a browser
 * build and is intentionally not installed here.)
 *
 * Next.js then retries with its on-demand downloader, which extracts into
 *
 *     <nextPackageDir>/wasm/@next/swc-wasm-nodejs
 *
 * but this device cannot reach the npm registry (ECONNRESET), and an earlier
 * aborted download left that directory *present but empty*. `downloadWasmSwc()`
 * short-circuits on `fs.existsSync(outputDirectory)` ("already downloaded"),
 * the import fails again, and the build dies with:
 *
 *     ⨯ Failed to load SWC binary for android/arm64
 *
 * THE FIX
 * -------
 * Stage the copy of `@next/swc-wasm-nodejs` that npm already installed into the
 * exact directory Next.js loads from. The staged package is the *same version*
 * as `next` (checked below), so there is no version drift, no second/conflicting
 * SWC package, and no Babel fallback. `downloadWasmSwc()` then sees a populated
 * directory and imports it successfully.
 *
 * Wired up as both `postinstall` and `prebuild` so the staging survives a fresh
 * `npm install`, and so a build is never attempted without it.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The files npm publishes for @next/swc-wasm-nodejs (its `files` field + manifest). */
const STAGED_FILES = ['package.json', 'wasm.js', 'wasm_bg.wasm', 'wasm.d.ts', 'README.md'];

function log(message) {
  console.log(`[setup-swc-wasm] ${message}`);
}

function readPackageJson(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

const nextPackageDir = join(projectRoot, 'node_modules', 'next');
const nextManifestPath = join(nextPackageDir, 'package.json');

if (!existsSync(nextManifestPath)) {
  log(`next is not installed yet (no ${nextManifestPath}); nothing to stage.`);
  process.exit(0);
}

const nextVersion = readPackageJson(nextPackageDir).version;
const sourceDir = join(projectRoot, 'node_modules', '@next', 'swc-wasm-nodejs');
const targetDir = join(nextPackageDir, 'wasm', '@next', 'swc-wasm-nodejs');

if (!existsSync(join(sourceDir, 'wasm.js')) || !existsSync(join(sourceDir, 'wasm_bg.wasm'))) {
  log(`WARNING: ${relative(projectRoot, sourceDir)} is not fully installed (wasm.js / wasm_bg.wasm missing).`);
  log(`Install the matching dev dependency with:  npm install --save-dev @next/swc-wasm-nodejs@${nextVersion}`);
  log('Skipping staging - `next build` will report the SWC load failure itself.');
  process.exit(0);
}

// Version drift between the JS loader and the WASM binary is the one thing that
// silently produces broken transforms, so refuse to stage a mismatched pair.
const wasmVersion = readPackageJson(sourceDir).version;
if (wasmVersion !== nextVersion) {
  log(`WARNING: @next/swc-wasm-nodejs is ${wasmVersion} but next is ${nextVersion}; they must match.`);
  log(`Reinstall with:  npm install --save-dev @next/swc-wasm-nodejs@${nextVersion}`);
  log('Skipping staging to avoid mixing SWC versions.');
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });

let copied = 0;
for (const name of STAGED_FILES) {
  const from = join(sourceDir, name);
  if (!existsSync(from)) continue;

  const to = join(targetDir, name);
  // Idempotent: same byte size means the staged copy is already current.
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;

  copyFileSync(from, to);
  copied += 1;
}

if (copied === 0) {
  log(`@next/swc-wasm-nodejs@${wasmVersion} already staged at ${relative(projectRoot, targetDir)}.`);
} else {
  log(`staged @next/swc-wasm-nodejs@${wasmVersion} -> ${relative(projectRoot, targetDir)} (${copied} file(s) copied).`);
}