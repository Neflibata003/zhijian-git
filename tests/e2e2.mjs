// 端到端测试（第二批）：分支 / 暂存修改 / 远程 / 冲突 / Amend / 标签 / 代码块暂存 / 追溯 / 搜索 / 帮助 / 克隆。
// 驱动真实 Release 程序，并用 git 命令独立核对结果；只使用临时目录。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from './cdp.mjs';

const EXE = path.resolve('src-tauri/target/release/paper-git.exe');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-e2e2-'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000, what = '') => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch { /* 继续等待 */ } await sleep(150); } throw new Error('等待超时 ' + what); };
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${c ? '' : '  ' + extra}`); };

const A = path.join(BASE, '写作项目'); fs.mkdirSync(A);
git(A, 'init', '-q', '-b', 'main'); git(A, 'config', 'user.name', '测试'); git(A, 'config', 'user.email', 't@e.com');
const w = (f, s) => fs.writeFileSync(path.join(A, f), s);
const long = (mark) => Array.from({ length: 40 }, (_, i) => `行${i + 1}${mark[i + 1] ?? ''}\n`).join('');
w('稿件.txt', long({})); w('f.txt', 'base\n'); git(A, 'add', '-A'); git(A, 'commit', '-qm', '第一版：起稿');
w('笔记.md', '笔记\n'); git(A, 'add', '-A'); git(A, 'commit', '-qm', '第二版：加笔记');
const bare = path.join(BASE, 'remote.git'); fs.mkdirSync(bare); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);

const cfg = path.join(process.env.APPDATA, 'local.paper.git', 'projects.json');
const backup = fs.existsSync(cfg) ? fs.readFileSync(cfg) : null; fs.writeFileSync(cfg, '[]');
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' };
try { execFileSync('taskkill', ['/IM', 'paper-git.exe', '/F'], { stdio: 'ignore' }); } catch { /* 未运行 */ }
await sleep(800);
spawn(EXE, [A], { env, stdio: 'ignore' });

const has = async (t, s) => (await t.text()).includes(s);
const tab = (t, name) => t.ev(`(()=>{const b=[...document.querySelectorAll('.tab')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(name)}));if(!b)return false;b.click();return true})()`);
const row = async (t, sel, text) => { const t0 = Date.now(); while (Date.now() - t0 < 10000) { if (await t.ev(`(()=>{const r=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.textContent.includes(${JSON.stringify(text)}));if(!r)return false;r.click();return true})()`)) return true; await sleep(150); } return false; };
const btn = async (t, sel, text) => { const t0 = Date.now(); while (Date.now() - t0 < 10000) { if (await t.ev(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.textContent.includes(${JSON.stringify(text)})&&!e.disabled);if(!b)return false;b.click();return true})()`)) return true; await sleep(150); } return false; };
const idle = (t) => until(() => t.ev(`!document.querySelector('.foot .bar')`), 15000, '操作结束');
const refreshUi = async (t) => { await btn(t, '.tb-actions button', ''); await sleep(300); await idle(t); };

try {
  const t = await connect();
  await until(() => has(t, '写作项目'), 15000, '打开项目');
  await until(() => has(t, '没有需要保存的修改') || has(t, '工作区很干净'), 8000);

  // ---- 帮助 ----
  await t.ev(`document.querySelector('button[aria-label="使用帮助"]').click()`);
  await until(() => has(t, '名词解释'), 10000);
  ok(await has(t, '我想…怎么做') && await has(t, '暂存修改'), '帮助：场景与名词解释可打开');
  await btn(t, '.modal .tab', '名词解释'); await sleep(200);
  ok(await has(t, 'Cherry-pick') && await has(t, 'Reflog'), '帮助：名词解释含 Git 术语');
  await btn(t, '.modal button', '知道了'); await until(() => t.ev(`!document.querySelector('.modal')`), 10000);

  // ---- 代码块暂存 ----
  w('稿件.txt', long({ 2: '（改）', 38: '（改）' })); await refreshUi(t);
  await row(t, '.row', '稿件.txt'); await until(() => has(t, '准备此块'), 8000, '代码块按钮');
  await btn(t, '.hunkbtn', '准备此块'); await idle(t);
  await until(() => git(A, 'diff', '--cached', '--name-only') === '稿件.txt', 10000);
  const cached = git(A, 'diff', '--cached', '-U0'); const work = git(A, 'diff', '-U0');
  ok(cached.includes('行2（改）') && !cached.includes('行38（改）') && work.includes('行38（改）'), '按代码块暂存：只暂存第一块，第二块仍未准备');

  // ---- 修改上一次保存 (Amend) ----
  const before = git(A, 'rev-list', '--count', 'HEAD');
  await t.ev(`(()=>{const c=document.querySelector('.commitbox input[type=checkbox]');c.click()})()`);
  await until(() => t.ev(`document.querySelector('textarea').value.includes('第二版')`), 5000, '预填上次说明');
  ok(true, 'Amend：勾选后自动带出上一次的说明');
  await t.typeInto('textarea', '第二版：加笔记（补上稿件修改）');
  await until(() => t.ev(`![...document.querySelectorAll('button')].find(b=>b.textContent.includes('更新上一次保存'))?.disabled`), 10000);
  await btn(t, 'button', '更新上一次保存'); await idle(t);
  ok(git(A, 'rev-list', '--count', 'HEAD') === before && git(A, 'show', '--name-only', '--format=%s', 'HEAD').includes('稿件.txt') && git(A, 'log', '-1', '--format=%s').includes('补上稿件修改'), 'Amend：版本数不变，补进了文件并更新说明');

  // ---- 撤销上次保存（保留修改）----
  await tab(t, '历史版本'); await until(() => t.ev(`document.querySelectorAll('.hrow').length===2`), 8000);
  await t.ev(`document.querySelector('.hrow').click()`); await until(() => has(t, '撤销上次保存（保留修改）'), 10000);
  await btn(t, 'button', '撤销上次保存（保留修改）'); await until(() => t.ev(`!!document.querySelector('.modal')`), 10000);
  await btn(t, '.modal button', '撤销并保留修改'); await idle(t);
  ok(git(A, 'rev-list', '--count', 'HEAD') === '1' && git(A, 'diff', '--cached', '--name-only').split('\n').includes('稿件.txt'), '撤销上次保存：版本回退一步，修改仍保留为“已准备保存”');
  // 重新保存，恢复到两个版本
  await tab(t, '修改'); await until(() => has(t, '已准备保存'), 12000);
  await t.typeInto('textarea', '第二版：加笔记与稿件'); await until(() => t.ev(`![...document.querySelectorAll('button')].find(b=>b.textContent.includes('保存版本'))?.disabled`), 10000);
  await btn(t, 'button', '保存版本'); await idle(t);
  await until(() => git(A, 'rev-list', '--count', 'HEAD') === '2', 10000);

  // ---- 标签 + 历史搜索 ----
  await tab(t, '历史版本'); await until(() => t.ev(`document.querySelectorAll('.hrow').length===2`), 8000);
  await t.ev(`document.querySelector('.hrow').click()`); await until(() => has(t, '贴标签'), 10000);
  await btn(t, 'button', '贴标签'); await until(() => t.ev(`!!document.querySelector('.modal')`), 10000);
  await t.typeInto('.modal input', 'v1.0'); await sleep(200); await btn(t, '.modal button', '创建'); await idle(t);
  ok(git(A, 'tag').split('\n').includes('v1.0'), '标签：可给版本贴标签');
  await until(() => t.ev(`!!document.querySelector('.refchip.tag')`), 10000);
  ok(true, '标签：历史列表显示标签徽章');
  await t.typeInto('.searchbar input', '起稿'); await until(() => t.ev(`document.querySelectorAll('.hrow').length===1`), 6000, '搜索过滤');
  ok(await has(t, '第一版：起稿'), '历史搜索：按说明过滤');
  await t.typeInto('.searchbar input', ''); await until(() => t.ev(`document.querySelectorAll('.hrow').length===2`), 12000);

  // ---- 逐行追溯 ----
  await t.ev(`document.querySelector('.hrow').click()`); await until(() => has(t, '逐行追溯'), 10000);
  await btn(t, '.hactions button', '逐行追溯'); await until(() => t.ev(`document.querySelectorAll('.bl').length>5`), 8000, '追溯行');
  ok(await has(t, '测试'), '逐行追溯：显示每行作者');
  await btn(t, '.blamebox button', '关闭'); await until(() => t.ev(`!document.querySelector('.blamebox')`), 10000);

  // ---- 连接远程并上传 ----
  await tab(t, '修改');
  ok(await has(t, '还没有连接远程仓库'), '同步条：未连接时给出说明');
  await btn(t, '.syncbar button', '连接远程仓库'); await until(() => t.ev(`!!document.querySelector('.modal')`), 10000);
  await t.typeInto('#ru', bare); await sleep(200); await btn(t, '.modal button', '保存'); await idle(t);
  await until(() => has(t, '获取更新'), 8000);
  await btn(t, '.syncbar button', '上传'); await idle(t);
  await until(() => { try { return git(bare, 'rev-parse', 'main').length === 40; } catch { return false; } }, 15000, '远程收到 main');
  ok(true, '远程：上传成功，远程仓库收到了分支');
  ok(await until(() => has(t, '与远程「origin/main」保持一致'), 8000).then(() => true), '同步条：显示已与远程一致');

  // ---- 分支：新建并切换 ----
  await tab(t, '分支'); await until(() => has(t, '新建分支'), 10000);
  await btn(t, '.sect button', '新建分支'); await until(() => t.ev(`!!document.querySelector('.modal')`), 10000);
  await t.typeInto('#bn', '试写新结局'); await sleep(200); await btn(t, '.modal button', '创建'); await idle(t);
  await until(() => git(A, 'branch', '--show-current') === '试写新结局', 8000, '已切换到新分支');
  ok(true, '分支：新建并切换（中文分支名）');
  w('新章节.txt', '在试验分支上的内容\n'); git(A, 'add', '新章节.txt'); git(A, 'commit', '-qm', '试验分支：新章节');
  await refreshUi(t);

  // ---- 分支：有未保存修改时切换 → 先暂存 ----
  w('f.txt', 'base\n本地未保存修改\n'); w('草稿.txt', '未跟踪的新文件\n'); await refreshUi(t);
  await tab(t, '分支'); await until(() => t.ev(`document.querySelectorAll('.brow').length>=2`), 12000);
  await until(() => row(t, '.brow', 'main'), 10000, '分支行 main'); await until(() => has(t, '切换到这条分支'), 10000);
  await btn(t, 'button', '切换到这条分支'); await until(() => t.ev(`!!document.querySelector('.modal')`), 10000);
  ok(await has(t, '你还有未保存的修改'), '切换分支：有未保存修改时给出选择');
  await btn(t, '.modal button', '先收进“暂存修改”'); await idle(t);
  await until(() => git(A, 'branch', '--show-current') === 'main', 8000, '回到 main');
  ok(git(A, 'status', '--porcelain') === '' && git(A, 'stash', 'list').split('\n').filter(Boolean).length === 1 && !fs.existsSync(path.join(A, '草稿.txt')), '切换分支：修改（含新文件）已安全收进暂存，工作区干净');

  // ---- 暂存修改：恢复 ----
  await tab(t, '暂存修改'); await until(() => t.ev(`document.querySelectorAll('.brow').length===1`), 12000);
  await t.ev(`document.querySelector('.brow').click()`); await until(() => has(t, '恢复并清理'), 10000);
  await btn(t, 'button', '恢复并清理'); await idle(t);
  await until(() => fs.existsSync(path.join(A, '草稿.txt')), 6000, '草稿恢复');
  ok(fs.readFileSync(path.join(A, 'f.txt'), 'utf8').includes('本地未保存修改') && git(A, 'stash', 'list') === '', '暂存修改：恢复后内容回来且记录被清理');
  // 保存这些改动，以便后面合并
  git(A, 'add', '-A'); git(A, 'commit', '-qm', 'main：整理草稿'); await refreshUi(t);

  // ---- 合并（无冲突）----
  await tab(t, '分支'); await until(() => t.ev(`document.querySelectorAll('.brow').length>=2`), 12000);
  await until(() => row(t, '.brow', '试写新结局'), 10000, '分支行 试写新结局'); await until(() => has(t, '合并到当前分支'), 10000);
  await btn(t, 'button', '合并到当前分支'); await until(() => t.ev(`!!document.querySelector('.modal')`), 10000);
  await until(() => btn(t, '.modal button', '开始合并'), 10000, '开始合并可点击'); await idle(t);
  await until(() => fs.existsSync(path.join(A, '新章节.txt')), 8000, '合并后文件出现');
  ok(git(A, 'log', '-1', '--format=%p').split(' ').length === 2, '合并：把试验分支并回 main，生成合并版本');

  // ---- 冲突：采用对方的 → 继续 ----
  git(A, 'checkout', '-q', '-b', 'c1'); w('f.txt', 'C1 的内容\n'); git(A, 'commit', '-qam', 'c1 改 f'); git(A, 'checkout', '-q', 'main'); w('f.txt', 'MAIN 的内容\n'); git(A, 'commit', '-qam', 'main 改 f'); await refreshUi(t);
  await tab(t, '分支'); await until(() => t.ev(`document.querySelectorAll('.brow').length>=3`), 12000);
  await until(() => row(t, '.brow', 'c1'), 10000, '分支行 c1'); await until(() => has(t, '合并到当前分支'), 10000);
  await btn(t, 'button', '合并到当前分支'); await until(() => t.ev(`!!document.querySelector('.modal')`), 10000);
  await until(() => btn(t, '.modal button', '开始合并'), 10000, '开始合并可点击'); await idle(t);
  await until(() => has(t, '有冲突，需要先处理'), 10000, '冲突分组');
  ok(await has(t, '操作未完成') || await has(t, '存在冲突'), '冲突：显示冲突状态与未完成的合并');
  await tab(t, '修改'); await row(t, '.row', 'f.txt'); await until(() => has(t, '采用对方的'), 10000);
  await btn(t, '.pane-head button', '采用对方的'); await idle(t);
  ok(fs.readFileSync(path.join(A, 'f.txt'), 'utf8').includes('C1 的内容'), '冲突：一键采用对方的内容并标记已解决');
  await until(() => t.ev(`![...document.querySelectorAll('.banner button')].find(b=>b.textContent.trim()==='继续')?.disabled`), 8000, '继续按钮可用');
  await btn(t, '.banner button', '继续'); await idle(t);
  await until(() => git(A, 'status', '--porcelain') === '' && git(A, 'log', '-1', '--format=%p').split(' ').length === 2, 8000, '合并完成');
  ok(true, '冲突：点“继续”完成合并');

  // ---- 克隆（走真实 IPC，避开系统文件夹选择器）----
  const cloneRes = await t.ev(`window.__TAURI_INTERNALS__.invoke('request',{op:'clone',path:${JSON.stringify(BASE)},args:{url:${JSON.stringify(bare)},name:'克隆出的项目'}}).then(r=>r.path)`);
  ok(fs.existsSync(path.join(cloneRes, '.git')) && git(cloneRes, 'log', '-1', '--format=%s').length > 0, '克隆：远程仓库完整下载到指定文件夹');
  const bad = await t.ev(`window.__TAURI_INTERNALS__.invoke('request',{op:'clone',path:${JSON.stringify(BASE)},args:{url:'https://u:tok@x.com/a.git',name:'z'}}).then(()=>'ok').catch(e=>String(e))`);
  ok(bad.includes('密码或令牌'), '克隆：拒绝含密码/令牌的网址');
  t.close();
} catch (e) { fail++; console.log('FAIL  异常: ' + e.message); try { const d = await connect(); console.log('--- 页脚:', await d.ev('document.querySelector(".foot")?.innerText')); console.log('--- 弹窗:', await d.ev('document.querySelector(".modal")?.innerText')); console.log('--- 中栏:', (await d.ev('document.querySelector(".mid")?.innerText')).slice(0, 300)); console.log('--- 右栏:', (await d.ev('document.querySelector(".main")?.innerText')).slice(0, 500)); console.log('--- 按钮:', await d.ev('[...document.querySelectorAll(".main button")].map(b=>b.textContent.trim()+(b.disabled?"(禁用)":""))')); } catch { /* 忽略 */ } }
finally {
  try { execFileSync('taskkill', ['/IM', 'paper-git.exe', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
  if (backup) fs.writeFileSync(cfg, backup); else fs.rmSync(cfg, { force: true });
  console.log(`\n结果: ${pass} 通过, ${fail} 失败   (测试目录 ${BASE})`);
  process.exit(fail ? 1 : 0);
}
