// 从 conventional commits 算下一语义版本, 交给 npm version 落地 (联动 syncver + 自动提交打 v* tag)
// 规则: BREAKING(!: 或 body 含 BREAKING CHANGE) -> major; feat -> minor; 其余 conventional -> patch; 非 conventional 忽略
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const dry = process.argv.includes('--dry');
const cur = JSON.parse(fs.readFileSync('package.json')).version;

// 自上次发版提交 (npm version 生成的, 标题即版本号) 以来的变更; 还没有发版提交就从仓库头算
const all = execSync('git log --pretty=%s%n%b%n\x1e', { encoding: 'utf8' }).split('\x1e').map((s) => s.trim()).filter(Boolean);
const last = all.findIndex((b) => /^v?\d+\.\d+\.\d+$/.test(b.split('\n')[0].trim()));
const changes = (last === -1 ? all : all.slice(0, last)).map((b) => b.replace(/\n+/g, ' ').trim());

const breaking = changes.filter((c) => /^[a-z]+(\(.+\))?!:/.test(c) || /BREAKING CHANGE:/.test(c));
const feats = changes.filter((c) => /^feat(\(.+\))?!?:/.test(c));
const others = changes.filter((c) => /^(fix|perf|refactor|docs|test|build|ci|chore|style)(\(.+\))?!?:/.test(c));
if (!breaking.length && !feats.length && !others.length) {
  console.log('没有可发布的 conventional 变更, 跳过');
  process.exit(1);
}

const [maj, min, pat] = cur.split('.').map(Number);
const next = breaking.length ? `${maj + 1}.0.0` : feats.length ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
console.log(`${cur} -> ${next}  (breaking ${breaking.length}, feat ${feats.length}, fix/chore ${others.length})`);
if (dry) process.exit(0);

execSync(`npm version ${next}`, { stdio: 'inherit' });
