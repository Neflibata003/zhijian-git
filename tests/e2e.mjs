// 端到端测试：驱动真实 Release 程序，并用 git 命令独立核对结果。仅使用临时目录中的测试仓库。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from './cdp.mjs';

const EXE = path.resolve('src-tauri/target/release/paper-git.exe');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-e2e-'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...a], { encoding: 'utf8' }).trim();
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${c ? '' : '  ' + extra}`); };

// ---- 准备测试仓库 ----
const A = path.join(BASE, '测试 项目');
fs.mkdirSync(A); git(A, 'init', '-q', '-b', 'main'); git(A, 'config', 'user.name', '测试'); git(A, 'config', 'user.email', 't@e.com');
fs.writeFileSync(path.join(A, '章节 一.txt'), '第一章\n从前有座山\n'); fs.writeFileSync(path.join(A, '说明.md'), 'v1\n');
fs.writeFileSync(path.join(A, '图.png'), Buffer.from([0, 1, 2, 3, 0, 255]));
git(A, 'add', '-A'); git(A, 'commit', '-qm', '首次保存');
fs.writeFileSync(path.join(A, '章节 一.txt'), '第一章\n从前有座山，山里有座庙\n'); git(A, 'add', '章节 一.txt');   // 已暂存
fs.appendFileSync(path.join(A, '说明.md'), 'v2\n');                                                         // 未暂存
fs.writeFileSync(path.join(A, '图.png'), Buffer.from([9, 9, 0, 9]));                                         // 二进制修改
fs.writeFileSync(path.join(A, '新增.txt'), '新文件\n');                                                       // 未跟踪
const B = path.join(BASE, '尚未建库'); fs.mkdirSync(B); fs.writeFileSync(path.join(B, 'a.txt'), 'hello\n');

const appData = path.join(process.env.APPDATA, 'local.paper.git', 'projects.json');
const backup = fs.existsSync(appData) ? fs.readFileSync(appData) : null; if (backup) fs.rmSync(appData);
const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222' };
const app = spawn(EXE, [A], { env, stdio: 'ignore', detached: false });

const rowClick = (t, text) => t.ev(`(()=>{const r=[...document.querySelectorAll('.row')].find(e=>e.textContent.includes(${JSON.stringify(text)}));if(!r)return false;r.click();return true})()`);
const rowCheck = (t, text) => t.ev(`(()=>{const r=[...document.querySelectorAll('.row')].find(e=>e.textContent.includes(${JSON.stringify(text)}));const c=r&&r.querySelector('input[type=checkbox]');if(!c)return false;c.click();return true})()`);
const has = (t, s) => t.text().then(x => x.includes(s));

try {
  const t = await connect();
  await t.waitFor(`document.body.innerText.includes('尚未准备保存')`, 15000);
  ok(await has(t, '已准备保存') && await has(t, '章节 一.txt'), '打开含中文/空格路径的仓库，区分已准备/尚未准备');
  ok((await t.text()).includes('4 项修改'), '状态显示 4 项修改');

  // 二进制文件不伪造差异
  await rowClick(t, '图.png'); await t.waitFor(`document.body.innerText.includes('此文件不支持文本差异预览')`);
  ok(true, '二进制文件提示“不支持文本差异预览”');

  // 已有暂存内容不被覆盖；勾选 说明.md 后只提交所选
  await rowCheck(t, '说明.md'); await t.waitFor(`document.querySelectorAll('.row input:checked').length===2`);
  ok(git(A, 'diff', '--cached', '--name-only').split('\n').sort().join() === '章节 一.txt,说明.md', '勾选文件后暂存区恰为所选两个文件');
  await t.typeInto('textarea', '写好第一章并更新说明');
  await t.waitFor(`![...document.querySelectorAll('button')].find(b=>b.textContent.includes('保存版本'))?.disabled`);
  await t.click('button', '保存版本');
  await t.waitFor(`document.body.innerText.includes('已保存版本')`);
  ok(git(A, 'log', '-1', '--format=%s') === '写好第一章并更新说明', '保存版本成功，说明正确');
  ok(git(A, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort().join() === '章节 一.txt,说明.md', '提交只包含勾选的两个文件');
  ok(git(A, 'status', '--porcelain').includes('图.png') && git(A, 'status', '--porcelain').includes('新增.txt'), '未选文件仍保留为未保存修改');

  // 在仍有未保存修改时撤销：应被拒绝并给出说明
  await t.click('.tab', '历史版本'); await t.waitFor(`document.querySelectorAll('.hrow').length===2`);
  ok(true, '历史版本列表加载 2 条');
  await t.click('.hrow'); await t.waitFor(`document.body.innerText.includes('撤销这次保存')`);
  await t.click('button', '撤销这次保存'); await t.waitFor(`!!document.querySelector('.modal')`);
  await t.click('.modal button', '新增撤销版本'); await t.waitFor(`!!document.querySelector('.foot .err')`);
  ok((await t.ev(`document.querySelector('.foot .err').textContent`)).length > 0 && git(A, 'rev-list', '--count', 'HEAD') === '2', '有未保存修改时撤销被拒绝且历史未变', await t.ev(`document.querySelector('.foot').textContent`));

  // 放弃修改：确认框说明影响，确认后恢复
  await t.click('.tab', '修改'); await t.waitFor(`document.body.innerText.includes('尚未准备保存')`);
  await rowClick(t, '图.png'); await t.waitFor(`document.body.innerText.includes('放弃修改')`);
  await t.click('button', '放弃修改'); await t.waitFor(`!!document.querySelector('.modal')`);
  ok((await t.ev(`document.querySelector('.modal').innerText`)).includes('永久丢失'), '放弃修改前明确提示会永久丢失');
  await t.click('.modal button', '放弃修改'); await t.waitFor(`!document.querySelector('.modal')`);
  await t.waitFor(`document.body.innerText.includes('已放弃修改') && !document.querySelector('.foot .bar')`);
  ok(Buffer.compare(fs.readFileSync(path.join(A, '图.png')), Buffer.from([0, 1, 2, 3, 0, 255])) === 0, '放弃修改后文件恢复为已保存版本');
  ok(fs.existsSync(path.join(A, '新增.txt')), '放弃一个文件不影响其他未保存文件');

  // 保存剩余后无修改状态；再撤销
  await t.click('button', '全部准备'); await t.waitFor(`document.querySelectorAll('.row input:checked').length>=1`);
  await t.typeInto('textarea', '添加新文件'); await t.waitFor(`![...document.querySelectorAll('button')].find(b=>b.textContent.includes('保存版本'))?.disabled`);
  await t.click('button', '保存版本'); await t.waitFor(`document.body.innerText.includes('当前修改已保存，可以继续安心编辑。')`);
  ok(git(A, 'status', '--porcelain') === '', '仓库确实干净时才显示“当前修改已保存”');
  await t.click('.tab', '历史版本'); await t.waitFor(`document.querySelectorAll('.hrow').length===3`);
  await t.click('.hrow'); await t.click('button', '撤销这次保存'); await t.waitFor(`!!document.querySelector('.modal')`);
  await t.click('.modal button', '新增撤销版本'); await t.waitFor(`document.querySelectorAll('.hrow').length===4`, 10000);
  ok(git(A, 'log', '-1', '--format=%s').startsWith('Revert') && !fs.existsSync(path.join(A, '新增.txt')), '撤销通过新增提交完成，原历史保留');

  // 单实例转发 + 创建仓库
  execFileSync(EXE, [B], { env, stdio: 'ignore' });
  await t.waitFor(`document.body.innerText.includes('还没有版本记录')`, 8000);
  ok(await has(t, B.replace(/\\/g, '\\')) || await has(t, '尚未建库'), '第二次启动把文件夹转发给已运行窗口，并显示创建仓库页');
  await t.click('button', '在此创建仓库'); await t.waitFor(`document.body.innerText.includes('尚无版本') || document.body.innerText.includes('这里还没有') || document.body.innerText.includes('1 项修改')`, 8000);
  ok(fs.existsSync(path.join(B, '.git')), '创建仓库成功');
  ok(fs.readdirSync(A).includes('.git') && !fs.existsSync(path.join(A, '.git', 'paper')), '未污染其他目录');
  t.close();
} catch (e) {
  fail++; console.log('FAIL  异常: ' + e.message);
  try {
    const d = await connect();
    console.log('--- 页脚:', await d.ev('document.querySelector(".foot")?.innerText'));
    console.log('--- 弹窗:', await d.ev('document.querySelector(".modal")?.innerText'));
    console.log('--- 中栏:', await d.ev('document.querySelector(".mid")?.innerText'));
    console.log('--- 按钮:', await d.ev('[...document.querySelectorAll(".mid button")].map(b=>b.textContent+(b.disabled?"(禁用)":""))'));
  } catch { /* 忽略 */ }
}
finally {
  try { execFileSync('taskkill', ['/IM', 'paper-git.exe', '/F'], { stdio: 'ignore' }); } catch {}
  if (backup) fs.writeFileSync(appData, backup);
  console.log(`\n结果: ${pass} 通过, ${fail} 失败   (测试目录 ${BASE})`);
  process.exit(fail ? 1 : 0);
}
