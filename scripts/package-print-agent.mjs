import { copyFile, mkdir, rm, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceDir = join(repoRoot, 'apps', 'print-agent');
const outputDir = join(repoRoot, 'dist', 'print-agent-windows');

const files = [
  ['package.json', 'package.json'],
  ['index.js', 'index.js'],
  ['print-pdf-windows.ps1', 'print-pdf-windows.ps1'],
  ['.env.example', '.env.example'],
  ['README.windows.md', 'README.md'],
  [join('windows', 'start-agent.ps1'), 'start-agent.ps1'],
  [join('windows', 'list-printers.ps1'), 'list-printers.ps1'],
  [join('windows', 'install-startup-task.ps1'), 'install-startup-task.ps1'],
  [join('windows', 'uninstall-startup-task.ps1'), 'uninstall-startup-task.ps1'],
  [join('windows', 'install-service-nssm.ps1'), 'install-service-nssm.ps1'],
  [join('windows', 'uninstall-service-nssm.ps1'), 'uninstall-service-nssm.ps1'],
];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const [from, to] of files) {
  await copyFile(join(sourceDir, from), join(outputDir, to));
}

await writeFile(
  join(outputDir, 'package-info.txt'),
  [
    'WMS Print Agent Windows package',
    `Generated at: ${new Date().toISOString()}`,
    '',
    'Copy this folder to the Windows computer that is connected to the printers.',
    'Read README.md before starting the agent.',
    '',
  ].join('\n'),
  'utf8',
);

console.log(`Created ${outputDir}`);
