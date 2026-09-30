// 性能测量：Release 版本，进程树（主进程 + 全部 WebView2 子进程）私有工作集口径。
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pexec = promisify(execFile);
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { connect } from './cdp.mjs';
const EXE = path.resolve('src-tauri/target/release/paper-git.exe');
const MEM = path.resolve('tests/memjson.ps1');
const memRaw = async () => JSON.parse((await pexec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MEM], { encoding: 'utf8' })).stdout.trim());
// 串行读取性能计数器，并在私有工作集读数为 0（计数器偶发缺失）时重试
let chain = Promise.resolve();
const mem = () => (chain = chain.catch(() => undefined).then(async () => { for (let i = 0; i < 4; i++) { const m = await memRaw(); if (m.priv > 0) return m; await new Promise((r) => setTimeout(r, 800)); } return memRaw(); }));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-perf-'));
const out = {};

// ---- 夹具 ----
const small = path.join(BASE, '小型仓库'); fs.mkdirSync(small); git(small, 'init', '-q', '-b', 'main'); git(small, 'config', 'user.name', 't'); git(small, 'config', 'user.email', 't@e.com');
for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(small, `文件${i}.txt`), `内容${i}\n`); git(small, 'add', '-A'); git(small, 'commit', '-qm', '初始'); fs.writeFileSync(path.join(small, '文件0.txt'), '改动\n');
const big = path.join(BASE, '大型仓库'); fs.mkdirSync(big); git(big, 'init', '-q', '-b', 'main'); git(big, 'config', 'user.name', 't'); git(big, 'config', 'user.email', 't@e.com');
{ let s = ''; const now = Math.floor(Date.now() / 1000) - 10000 * 60;
  for (let i = 0; i < 10000; i++) { const m = `版本 ${i + 1}：更新记录`; const c = `内容 ${i}\n`; s += `commit refs/heads/main\ncommitter t <t@e.com> ${now + i * 60} +0800\ndata ${Buffer.byteLength(m)}\n${m}\nM 100644 inline log.txt\ndata ${Buffer.byteLength(c)}\n${c}\n`; }
  execFileSync('git', ['-C', big, 'fast-import', '--quiet'], { input: s }); git(big, 'reset', '-q', '--hard');
  fs.mkdirSync(path.join(big, 'many')); for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(big, 'many', `文件${i}.txt`), `行${i}\n`); }
const extra = []; for (let k = 0; k < 3; k++) { const d = path.join(BASE, `项目${k}`); fs.mkdirSync(d); git(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'a.txt'), String(k)); extra.push(d); }
const cfg = path.join(process.env.APPDATA, 'local.paper.git', 'projects.json');
const backup = fs.existsSync(cfg) ? fs.readFileSync(cfg) : null;
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' };
const kill = () => { try { execFileSync('taskkill', ['/IM', 'paper-git.exe', '/F'], { stdio: 'ignore' }); } catch {} };
const settle = async (label, secs = 30) => { await sleep(secs * 1000); const a = await mem(); await sleep(5000); const b = await mem(); out[label] = { ...b, cpuIdle5s: +(b.cpu - a.cpu).toFixed(2) }; console.log(label, JSON.stringify(out[label])); };

try {
  kill(); await sleep(1500);
  // 1) 冷启动到可操作 + 无项目空闲
  fs.writeFileSync(cfg, '[]');
  const t0 = Date.now(); const app = spawn(EXE, [], { env, stdio: 'ignore' });
  const t = await connect(); await t.waitFor(`document.body.innerText.includes('选择文件夹')`, 20000);
  out.coldStartMs = Date.now() - t0; console.log('冷启动到可操作(ms)', out.coldStartMs);
  await settle('无项目空闲', 100);
  // 2) 小型仓库
  execFileSync(EXE, [small], { env, stdio: 'ignore' }); await t.waitFor(`document.body.innerText.includes('尚未准备保存')`, 12000);
  await settle('小型仓库空闲', 60);
  // 3) 大仓库：5000 个未跟踪文件 + 1 万条历史
  execFileSync(EXE, [big], { env, stdio: 'ignore' }); await t.waitFor(`document.body.innerText.includes('尚未准备保存')`, 60000);
  let peak = 0, sampling = false; const sample = setInterval(async () => { if (sampling) return; sampling = true; try { const m = await mem(); peak = Math.max(peak, m.priv); } catch { /* 忽略单次采样失败 */ } sampling = false; }, 1500);
  const rows = await t.ev(`document.querySelectorAll('.row').length`); out.bigListDomRows = rows;
  for (let i = 0; i < 40; i++) { await t.ev(`(document.querySelector('.list').scrollTop += 900, true)`); await sleep(60); }
  await t.click('.tab', '历史版本'); await t.waitFor(`document.querySelectorAll('.hrow').length>=50`, 15000);
  for (let i = 0; i < 20; i++) { await t.click('button', '加载更多'); await sleep(450); }
  out.historyLoaded = await t.ev(`(document.querySelector('.list').firstChild?.style?.height||'')`);
  for (let i = 0; i < 30; i++) { await t.ev(`(document.querySelector('.list').scrollTop += 1500, true)`); await sleep(60); }
  await t.click('.hrow'); await sleep(1500);
  clearInterval(sample); out.bigPeakPrivate = peak; console.log('大仓库浏览期间私有工作集峰值', peak, '首屏 DOM 行数', rows);
  await settle('大仓库浏览后空闲', 60);
  // 4) 连续切换 40 次
  
  for (let i = 0; i < 40; i++) { const d = i % 2 ? extra[i % 3] : small; execFileSync(EXE, [d], { env, stdio: 'ignore' }); await sleep(500); }
  await sleep(2000); await settle('连续切换40次后空闲', 60); out.switchDelta = +(out['连续切换40次后空闲'].priv - out['小型仓库空闲'].priv).toFixed(1);
  // 5) 最小化后 CPU
  const { windowId } = (await t.send('Browser.getWindowForTarget')).result;
  await t.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }); await sleep(3000);
  const c1 = await mem(); await sleep(30000); const c2 = await mem(); out.minimized = { cpu30s: +(c2.cpu - c1.cpu).toFixed(2), priv: c2.priv }; console.log('最小化 30 秒 CPU(s)', out.minimized);
  t.close();
} catch (e) { console.log('异常', e.message); }
finally { kill(); if (backup) fs.writeFileSync(cfg, backup); else fs.rmSync(cfg, { force: true }); fs.writeFileSync('tests/perf-result.json', JSON.stringify(out, null, 2)); console.log('已写入 tests/perf-result.json'); }
