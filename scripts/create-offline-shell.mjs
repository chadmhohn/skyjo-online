import fs from 'node:fs/promises';
import path from 'node:path';

const distDirectory = path.resolve('dist');
const indexPath = path.join(distDirectory, 'index.html');
const offlinePath = path.join(distDirectory, 'offline.html');
const index = await fs.readFile(indexPath, 'utf8');
if (!/<div id="root"><\/div>/.test(index) || !/<script[^>]+src="\/assets\//.test(index)) {
  throw new Error('Built app shell is not safe to promote as the offline shell.');
}
if (/<script(?![^>]+src="\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.js")[^>]*>/i.test(index)) {
  throw new Error('Offline shell contains an inline or non-fingerprinted script.');
}
if (/<link[^>]+rel="stylesheet"[^>]+href="(?!\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.css")[^"]+"/i.test(index)) {
  throw new Error('Offline shell contains a non-fingerprinted stylesheet.');
}
if (/skyjo_(?:account|session)|set-cookie|invite-code|"email"|"userId"/i.test(index)) {
  throw new Error('Offline shell contains account, invite, or session data.');
}
const offline = index.replace(
  /<head>/,
  '<head>\n    <meta name="skyjo-offline-shell" content="data-free" />'
);
await fs.writeFile(offlinePath, offline, 'utf8');
console.log('Created data-free offline solo shell.');
