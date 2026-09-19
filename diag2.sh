#!/bin/sh
APP=/data/user/0/com.vscodroid/files/projects/assetscout-stripe
cd "$APP" || exit 1

echo "--- rootfs writable? ---"
ls -ld / /usr /usr/bin /bin 2>&1
echo "--- mkdir /usr/bin ---"
mkdir -p /usr/bin 2>&1 && echo "mkdir ok" || echo "mkdir failed"
echo "--- env binaries anywhere? ---"
command -v env 2>&1
ls -l "$PREFIX/bin/env" 2>&1
echo "--- chmod +x the next cli ---"
chmod +x node_modules/next/dist/bin/next 2>&1 && echo "chmod ok" || echo "chmod failed"
ls -l node_modules/next/dist/bin/next
echo "--- run shim after chmod ---"
./node_modules/.bin/next --version 2>&1 | tail -3
echo "--- run via sh -c (npm style) ---"
PATH="$PWD/node_modules/.bin:$PATH" sh -c 'next --version' 2>&1 | tail -3
echo "--- shells ---"
ls -l /bin/sh /system/bin/sh 2>&1
echo "DONE"