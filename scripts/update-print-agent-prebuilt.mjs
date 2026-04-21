import { copyFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const generatedExe = join(repoRoot, 'dist', 'print-agent-windows', 'wms-print-agent.exe');
const prebuiltExe = join(repoRoot, 'apps', 'print-agent', 'prebuilt', 'wms-print-agent.exe');

await mkdir(dirname(prebuiltExe), { recursive: true });
await copyFile(generatedExe, prebuiltExe);

console.log(`Updated ${prebuiltExe}`);
