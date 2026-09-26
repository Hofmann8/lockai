// 把 pdf.js 的 worker、CJK 字符映射（cmaps）和标准字体复制到 public/pdfjs/，
// sql.js 的 WebAssembly 复制到 public/sqljs/（数据库阅读器用），
// 网页里的阅读器从同源地址加载，不依赖打包器处理 worker / wasm，也不走第三方 CDN。
// predev / prebuild 自动运行；public/pdfjs/、public/sqljs/ 是生成物，不进 git。
// 不用 fs.cpSync：Node 22 在 Windows 的非 ASCII 路径下会报 unknown error。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const out = join(root, 'public', 'pdfjs');
const { version } = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
const stamp = join(out, 'VERSION');

// sql.js：只有一个 wasm 文件，每次都复制（很快）
const sqlOut = join(root, 'public', 'sqljs');
mkdirSync(sqlOut, { recursive: true });
copyFileSync(join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'), join(sqlOut, 'sql-wasm.wasm'));

if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) process.exit(0);

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(join(from, entry.name), join(to, entry.name));
    else copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}

mkdirSync(out, { recursive: true });
copyFileSync(join(src, 'build', 'pdf.worker.min.mjs'), join(out, 'pdf.worker.min.mjs'));
copyDir(join(src, 'cmaps'), join(out, 'cmaps'));
copyDir(join(src, 'standard_fonts'), join(out, 'standard_fonts'));
writeFileSync(stamp, version);
console.log(`pdf.js ${version} assets -> public/pdfjs/`);
