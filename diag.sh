#!/bin/sh
# Local build-rig diagnostics for the AssetScout Next.js project (Android/vscodroid).
APP=/data/user/0/com.vscodroid/files/projects/assetscout-stripe
cd "$APP" || exit 1

echo "PATH=$PATH"
echo "--- node/npm ---"
command -v node
node -v
command -v npm
echo "--- interpreters ---"
ls -la /usr/bin/env 2>&1
ls -la "$PREFIX/bin/env" 2>&1
echo "--- global next on PATH? ---"
command -v next 2>&1
echo "--- .bin/next ---"
ls -l node_modules/.bin/next
echo "--- head of next cli ---"
head -3 node_modules/next/dist/bin/next
echo "--- exec .bin/next (shim) ---"
./node_modules/.bin/next --version 2>&1 | tail -3
echo "--- exec sh -c 'next --version' with npm-style PATH ---"
PATH="$PWD/node_modules/.bin:$PATH" sh -c 'next --version' 2>&1 | tail -3
echo "--- exec via plain node (workaround form) ---"
node node_modules/next/dist/bin/next --version 2>&1 | tail -3
echo "--- next type declarations ---"
ls -la node_modules/next/server.d.ts node_modules/next/headers.d.ts node_modules/next/index.d.ts 2>&1
echo "--- swc wasm present? ---"
ls node_modules/@next 2>&1
echo "--- next-env.d.ts present? ---"
ls -la next-env.d.ts 2>&1
echo "--- .next contents ---"
find .next -maxdepth 2 2>/dev/null | head -20
echo "DONE"