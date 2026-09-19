const targets = [
  ['stripe', '22.6.2'],
  ['@supabase/ssr', '0.7.0'],
  ['@supabase/supabase-js', '2.116.0'],
  ['next', '15.5.7'],
  ['zod', '3.25.76'],
  ['@next/swc-wasm-nodejs', '15.5.7'],
  ['react', '19.1.0'],
  ['server-only', '0.0.1'],
];
for (const [name, want] of targets) {
  try {
    const r = await fetch('https://registry.npmjs.org/' + name, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    const j = await r.json();
    const pv = j.versions[want];
    if (!pv) {
      console.log(name.padEnd(26), 'VERSION ' + want + ' NOT FOUND; latest=' + j['dist-tags'].latest);
      continue;
    }
    console.log(
      name.padEnd(26),
      want.padEnd(10),
      'peer=' + JSON.stringify(pv.peerDependencies || {}),
      'peerMeta=' + JSON.stringify(pv.peerDependenciesMeta || {}),
      'engines=' + JSON.stringify(pv.engines || {}),
    );
  } catch (e) {
    console.log(name.padEnd(26), 'ERR ' + e.message);
  }
}