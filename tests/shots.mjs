// 生成界面截图：驱动真实 Release 程序，PrintWindow 截取窗口。使用临时目录中的示例仓库。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from './cdp.mjs';

const EXE = path.resolve('src-tauri/target/release/paper-git.exe');
const OUT = path.resolve('tests/screens'); fs.mkdirSync(OUT, { recursive: true });
const SHOT = path.resolve('tests/shot.ps1');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-shot-'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const shot = (name) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SHOT, '-out', path.join(OUT, name + '.png')], { stdio: 'ignore' });

const R = path.join(BASE, '我的小说'); fs.mkdirSync(R); git(R, 'init', '-q', '-b', 'main'); git(R, 'config', 'user.name', '林小满'); git(R, 'config', 'user.email', 'xm@example.com');
const w = (f, s) => fs.writeFileSync(path.join(R, f), s);
w('第一章 山中.txt', '第一章 山中\n\n清晨，山里起了薄雾。\n他沿着石阶往上走，听见远处有钟声。\n钟声很轻，像是从很久以前传来的。\n'); w('人物设定.md', '# 人物\n\n- 林远：主角，沉默寡言\n- 阿岚：山下的药师\n'); w('封面.png', Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]));
git(R, 'add', '-A'); git(R, 'commit', '-qm', '建立目录，写下第一章开头');
w('人物设定.md', '# 人物\n\n- 林远：主角，沉默寡言\n- 阿岚：山下的药师，知道山中的秘密\n- 老僧：守钟人\n'); git(R, 'commit', '-qam', '补充人物设定');
w('第二章 山下.txt', '第二章 山下\n\n药铺的门半开着。\n'); git(R, 'add', '-A'); git(R, 'commit', '-qm', '开始写第二章');
// 当前修改：已暂存 1 个、未暂存 2 个、未跟踪 1 个、二进制 1 个
w('第一章 山中.txt', '第一章 山中\n\n清晨，山里起了薄雾。\n他沿着石阶往上走，听见远处有钟声。\n钟声很轻，像是从很久以前传来的。\n他停下脚步，想起了阿岚说过的话。\n\n“钟响三遍，山门才会开。”\n'); git(R, 'add', '第一章 山中.txt');
w('第二章 山下.txt', '第二章 山下\n\n药铺的门半开着，檐下挂着风干的草药。\n阿岚正在称药。\n'); w('人物设定.md', '# 人物\n\n- 林远：主角，沉默寡言\n- 阿岚：山下的药师，知道山中的秘密\n- 老僧：守钟人，年岁不详\n'); w('第三章 提纲.md', '- 山门\n- 钟声\n'); w('封面.png', Buffer.from([137, 80, 78, 71, 9, 9, 9]));

const cfg = path.join(process.env.APPDATA, 'local.paper.git', 'projects.json');
const backup = fs.existsSync(cfg) ? fs.readFileSync(cfg) : null; fs.writeFileSync(cfg, '[]');
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' };
const localTheme = (t, v) => t.ev(`(localStorage.setItem('pg-theme','${v}'),true)`);
let app = spawn(EXE, [], { env, stdio: 'ignore' });
try {
  const t = await connect(); await t.sleep(1800);
  await localTheme(t, 'light'); await t.ev('location.reload()'); await t.sleep(1500);
  shot('01-欢迎页');
  execFileSync(EXE, [R], { env, stdio: 'ignore' });
  await t.waitFor(`document.body.innerText.includes('尚未准备保存')`, 12000); await t.sleep(600);
  shot('02-修改-浅色');
  await t.click('.seg button', '左右对照'); await t.sleep(400); shot('03-左右对照-浅色');
  await t.click('.row', '人物设定'); await t.sleep(500); await t.click('.row', '封面.png'); await t.sleep(500); shot('04-二进制文件');
  await t.click('.tab', '历史版本'); await t.waitFor(`document.querySelectorAll('.hrow').length===3`); await t.click('.hrow'); await t.sleep(900); shot('05-历史版本');
  await t.click('.tab', '修改'); await t.sleep(300);
  await t.ev(`(localStorage.setItem('pg-theme','dark'),true)`); await t.ev('location.reload()'); await t.sleep(1800);
  await t.waitFor(`document.body.innerText.includes('尚未准备保存')`, 10000); await t.sleep(400); shot('06-修改-深色');
  await t.ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true}))`); await t.sleep(400); shot('07-命令面板-深色');
  await t.ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  await t.ev(`document.querySelector('.palette input')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await t.ev(`(localStorage.setItem('pg-theme','light'),true)`); await t.ev('location.reload()'); await t.sleep(1800);
  // 全部保存后的“干净”状态
  git(R, 'add', '-A'); git(R, 'commit', '-qm', '写完第一章，整理设定'); await t.ev('location.reload()'); await t.sleep(2000); shot('08-无修改');
  t.close();
} catch (e) { console.log('异常:', e.message); }
finally {
  try { execFileSync('taskkill', ['/IM', 'paper-git.exe', '/F'], { stdio: 'ignore' }); } catch {}
  if (backup) fs.writeFileSync(cfg, backup); else fs.rmSync(cfg, { force: true });
  console.log('完成', fs.readdirSync(OUT).join(' '));
}
