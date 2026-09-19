const wanted = {
  next: ['15.5.4', '15.5.7', '16.3.5'],
  '@next/swc-wasm-nodejs': ['15.5.4', '15.5.7'],
  tailwindcss: ['3.4.17'],
  zod: ['3.25.76', '4.1.12'],
  typescript: ['5.9.2'],
};
const all = ['next', 'react', 'react-dom', 'tailwindcss', 'zod', 'typescript', 'nodemailer', 'postcss', 'autoprefixer', 'eslint', 'eslint-config-next', ...Object.keys(wanted)];
for (const p of [...new Set(all)]) {
  try {
    const r = await fetch('https://registry.npmjs.org/' + encodeURIComponent(p), { headers: { accept: 'application/vnd.npm.install-v1+json' } });
    const j = await r.json();
    const vers = Object.keys(j.versions || {});
    let out = 'latest=' + ((j['dist-tags'] || {}).latest);
    if (wanted[p]) out += ' | ' + wanted[p].map((v) => v + '=' + (vers.includes(v) ? 'YES' : 'no')).join(', ');
    console.log(p.padEnd(26), out);
  } catch (e) {
    console.log(p.padEnd(26), 'ERR ' + e.message);
  }
}