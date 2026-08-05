import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('apps/company-site');
const requiredFiles = [
  'index.html',
  'privacy/index.html',
  'terms/index.html',
  'security/index.html',
  'assets/styles.css',
  'assets/site.js',
  'assets/og.png',
  'robots.txt',
  'sitemap.xml',
];

for (const file of requiredFiles) {
  await access(resolve(root, file));
}

const pages = await Promise.all(
  requiredFiles.filter((file) => file.endsWith('.html')).map(async (file) => ({
    file,
    html: await readFile(resolve(root, file), 'utf8'),
  })),
);

const home = pages.find(({ file }) => file === 'index.html')?.html ?? '';
const privacy = pages.find(({ file }) => file === 'privacy/index.html')?.html ?? '';

const assertions = [
  ['home identifies the legal entity', home.includes('乳山市弗朗克贸易有限公司')],
  ['home names the product', home.includes('Fulangke WMS')],
  ['home describes FBA and FBM', home.includes('FBA') && home.includes('FBM')],
  ['home describes pricing', home.includes('邀请制测试阶段') && home.includes('按协议报价')],
  ['home provides direct contact', home.includes('mailto:flachic0001@gmail.com')],
  ['home links privacy policy', home.includes('href="/privacy/"')],
  ['home links terms', home.includes('href="/terms/"')],
  ['home includes ICP filing', home.includes('鲁ICP备2026043725号-1')],
  ['privacy covers collection', privacy.includes('我们收集的信息')],
  ['privacy covers sharing', privacy.includes('信息共享与处理方')],
  ['privacy covers retention and deletion', privacy.includes('保存期限与删除')],
  ['privacy discloses Amazon data use', privacy.includes('Amazon Selling Partner API')],
];

const failures = assertions.filter(([, passed]) => !passed).map(([label]) => label);
if (failures.length) {
  console.error(`Company site validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

for (const { file, html } of pages) {
  if (/placeholder|lorem ipsum|建设中|under construction/i.test(html)) {
    console.error(`Forbidden placeholder content found in ${file}`);
    process.exit(1);
  }
}

console.log('Company site validation passed.');
