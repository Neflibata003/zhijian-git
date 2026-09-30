// 回归：几千个文件 + 大二进制时“全部准备”“保存版本”“全部取消”不应报错
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { connect } from './cdp.mjs';
const EXE = path.resolve('src-tauri/target/release/paper-git.exe');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-e2e3-'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return; } catch {} await sleep(200); } throw new Error('等待超时 ' + what); };
let pass = 0, fail = 0; const ok = (c, n, e = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + e}`); };
const R = path.join(BASE, '大项目'); fs.mkdirSync(R); git(R, 'init', '-q', '-b', 'main'); git(R, 'config', 'user.name', 't'); git(R, 'config', 'user.email', 't@e.com');
fs.writeFileSync(path.join(R, 'a.txt'), 'a'); git(R, 'add', '-A'); git(R, 'commit', '-qm', '初始');
fs.mkdirSync(path.join(R, '.zcode', 'v2', 'cache', 'content-bundles'), { recursive: true });
for (let i = 0; i < 8000; i++) fs.writeFileSync(path.join(R, '.zcode', 'v2', 'cache', 'content-bundles', `火力发电厂虚拟仿真实验报告_润色版_${i}.txt`), `n${i}`);
for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(R, `报告${i}.docx`), randomBytes(4 * 1024 * 1024));
const cfg = path.join(process.env.APPDATA, 'local.paper.git', 'projects.json'); const backup = fs.existsSync(cfg) ? fs.readFileSync(cfg) : null; fs.writeFileSync(cfg, '[]');
try { execFileSync('taskkill', ['/IM', 'paper-git.exe', '/F'], { stdio: 'ignore' }); } catch {}
await sleep(800);
spawn(EXE, [R], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' }, stdio: 'ignore' });
const btn = (t, text) => t.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.includes(${JSON.stringify(text)})&&!e.disabled);if(!b)return false;b.click();return true})()`);
try {
  const t = await connect();
  await until(() => t.ev(`document.body.innerText.includes('全部准备')`), 90000, '列表出现');
  ok(true, '8006 个未跟踪文件的列表可以显示');
  await until(() => btn(t, '全部准备'), 10000, '点击全部准备');
  await until(() => t.ev(`document.body.innerText.includes('全部取消')`), 120000, '全部准备完成');
  ok(Number(git(R, 'diff', '--cached', '--name-only').split('\n').length) >= 8006, '全部准备：8006 个文件都进入暂存区（无 os error 206）');
  ok(!(await t.ev(`document.querySelector('.foot').innerText`)).includes('os error'), '页脚没有报错');
  await t.typeInto('textarea', '一次保存全部');
  await until(() => t.ev(`![...document.querySelectorAll('button')].find(b=>b.textContent.includes('保存版本'))?.disabled`), 20000, '保存按钮可用');
  await btn(t, '保存版本');
  await until(() => t.ev(`document.body.innerText.includes('已保存版本')`), 180000, '保存完成');
  ok(git(R, 'rev-list', '--count', 'HEAD') === '2' && git(R, 'status', '--porcelain') === '', '保存版本成功：含大二进制也不触发输出上限，工作区干净');
  t.close();
} catch (e) { fail++; console.log('FAIL  异常: ' + e.message); try { const d = await connect(); console.log('页脚:', await d.ev('document.querySelector(".foot")?.innerText')); } catch {} }
finally { try { execFileSync('taskkill', ['/IM', 'paper-git.exe', '/F'], { stdio: 'ignore' }); } catch {} if (backup) fs.writeFileSync(cfg, backup); else fs.rmSync(cfg, { force: true }); fs.rmSync(BASE, { recursive: true, force: true }); console.log(`\n结果: ${pass} 通过, ${fail} 失败`); process.exit(fail ? 1 : 0); }
