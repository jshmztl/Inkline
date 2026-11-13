import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
}

const desktopPackage = readJson('apps/desktop/package.json');
const tauriConfig = readJson('apps/desktop/src-tauri/tauri.conf.json');
const cargoToml = readFileSync(resolve(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

const versions = [
  ['apps/desktop/package.json', desktopPackage.version],
  ['apps/desktop/src-tauri/tauri.conf.json', tauriConfig.version],
  ['apps/desktop/src-tauri/Cargo.toml', cargoVersion],
];

const expected = versions[0][1];
const mismatched = versions.filter(([, version]) => version !== expected);

if (!expected || mismatched.length > 0) {
  console.error('版本号不一致，请先同步：');
  for (const [file, version] of versions) {
    console.error(`  ${file}: ${version ?? '未找到'}`);
  }
  process.exit(1);
}

console.log(`版本号一致：${expected}`);
