import { useState, type ReactNode } from 'react';
import { Info, X } from 'lucide-react';
import { Modal } from './ui';

/** 可关闭的「这是什么」提示卡；关闭后记住，不再打扰。 */
export function Explain({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const key = `pg-hint-${id}`;
  const [gone, setGone] = useState(() => localStorage.getItem(key) === '1');
  if (gone) return null;
  return (
    <aside className="explain" aria-label={`说明：${title}`}>
      <Info size={16} aria-hidden />
      <div><b>{title}</b><div>{children}</div></div>
      <button className="btn icon small ghost" aria-label="不再显示这条说明" title="知道了，不再显示" onClick={() => { localStorage.setItem(key, '1'); setGone(true); }}><X size={14} /></button>
    </aside>
  );
}

/** 重新显示所有被关闭过的说明卡。 */
export const resetHints = () => { Object.keys(localStorage).filter((k) => k.startsWith('pg-hint-')).forEach((k) => localStorage.removeItem(k)); };

const TERMS: { zh: string; en: string; what: string }[] = [
  { zh: '仓库', en: 'Repository', what: '装着一个文件夹全部历史的“档案盒”。你的项目文件夹加上里面隐藏的 .git 文件夹，就是一个仓库。' },
  { zh: '版本', en: 'Commit', what: '一次存档快照。点“保存版本”，就给选中的文件拍一张照，以后随时能回看、回到这一刻。只保存在你的电脑里，不会上传。' },
  { zh: '已准备保存', en: 'Staged / 暂存区', what: '你挑进“下一张快照”的文件，像把要拍照的东西先摆到桌上。勾选文件就是准备；没勾的不会被保存。' },
  { zh: '分支', en: 'Branch', what: '一条平行的“草稿线”。想试新点子时开一条分支，随便改，不影响主线；满意了再合并回来，不满意直接丢掉。' },
  { zh: '合并', en: 'Merge', what: '把一条分支上的成果并进另一条分支（通常并回主线）。' },
  { zh: '冲突', en: 'Conflict', what: '两边改了同一个地方，Git 不知道该留谁的，需要你来决定：保留我的、采用对方的，或手动改成两者的结合。' },
  { zh: '暂存修改', en: 'Stash', what: '把写到一半的改动先收进“抽屉”，让工作区回到干净，之后随时取回。注意：它和“已准备保存”不是一回事。' },
  { zh: '远程', en: 'Remote', what: '放在网络上的仓库副本（如 GitHub、Gitee），用来备份，也用来和别人协作。' },
  { zh: '获取更新', en: 'Fetch', what: '只是去看看远程有什么新东西，不会改动你的文件，非常安全。' },
  { zh: '拉取', en: 'Pull', what: '获取远程更新，并合并进你当前的分支。有未保存的修改时会先要求你处理。' },
  { zh: '上传', en: 'Push', what: '把你电脑上保存好的版本送到远程。本应用永远不会“强制上传”，避免覆盖别人的成果。' },
  { zh: '标签', en: 'Tag', what: '给某个版本贴一张永久的名字贴纸，比如“v1.0 定稿”，方便以后一眼找到。' },
  { zh: '修改上一次保存', en: 'Amend', what: '刚保存完发现漏了文件或说明写错了，可以补救。只适合还没上传的最近一次保存。' },
  { zh: '撤销这次保存', en: 'Revert', what: '新增一个“反向”版本，抵消某次保存的改动。历史记录原样保留，是最安全的撤销方式。' },
  { zh: '回到此版本', en: 'Reset', what: '把当前分支退回到过去的某个版本。“保留修改”只移动记录、文件不变；“彻底回到”会丢弃之后的内容，所以要求输入分支名确认。' },
  { zh: '复制这次保存', en: 'Cherry-pick', what: '把另一条分支上的某一次保存，单独挑过来放到当前分支。' },
  { zh: '逐行追溯', en: 'Blame', what: '查看文件里每一行是谁、在什么时候、为什么改的。' },
  { zh: '游离 HEAD', en: 'Detached HEAD', what: '你正停在一个历史版本上，不属于任何分支。此时新保存的版本容易“丢失”，建议先“在此创建分支”。' },
  { zh: '操作记录', en: 'Reflog', what: 'Git 悄悄记下你每次移动到过的位置，是“后悔药”，能找回误操作之前的状态（按 Ctrl+K 搜索“操作记录”）。' },
];

const RECIPES: { q: string; a: string }[] = [
  { q: '保存我今天写的内容', a: '在「修改」里勾选要保存的文件 → 写一句说明 → 点「保存版本」。' },
  { q: '想试个大改动，又怕改坏', a: '「分支」→ 新建分支并切换 → 放心修改 → 满意后切回主分支，选中试验分支点「合并到当前分支」。' },
  { q: '改到一半，要先处理别的事', a: '「暂存修改」→ 暂存当前修改。回来后在同一页点「恢复」，就能接着写。' },
  { q: '改乱了，想回到上次保存的样子', a: '「修改」里选中文件 → 点「放弃修改」。注意：这些未保存的修改会永久丢失。' },
  { q: '刚保存的版本不对', a: '还没上传：「历史版本」里选最新一项 → 「撤销上次保存（保留修改）」，或勾选漏掉的文件后用「修改上一次保存」。已上传：用「撤销这次保存」。' },
  { q: '把项目备份到网上', a: '顶部条点「连接远程仓库」→ 粘贴仓库网址 → 点「上传」。第一次登录由 Windows 的 Git 凭据管理器弹窗完成，本应用不保存密码。' },
  { q: '和别人一起写', a: '先「获取更新」看有没有新内容 → 有就「拉取」→ 遇到冲突按提示处理 → 最后「上传」。' },
  { q: '误操作把版本弄丢了', a: '按 Ctrl+K，输入“操作记录”，找到出问题之前的那一步，选择“回到这一步”。' },
];

export function HelpModal({ onClose, onReset }: { onClose: () => void; onReset: () => void }) {
  const [tab, setTab] = useState<'recipes' | 'terms'>('recipes');
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal help" role="dialog" aria-modal="true" aria-label="使用帮助">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ flex: 1 }}>使用帮助</h3>
          <button className="btn icon small ghost" aria-label="关闭" onClick={onClose}><X size={16} /></button>
        </div>
        <p className="muted">纸笺 Git 帮你给文件夹留下每一个版本。不用记命令，下面是常见场景和名词解释。</p>
        <div className="tabs" role="tablist" style={{ padding: 0 }}>
          <button role="tab" aria-selected={tab === 'recipes'} className={`tab ${tab === 'recipes' ? 'on' : ''}`} onClick={() => setTab('recipes')}>我想…怎么做</button>
          <button role="tab" aria-selected={tab === 'terms'} className={`tab ${tab === 'terms' ? 'on' : ''}`} onClick={() => setTab('terms')}>名词解释</button>
        </div>
        <div className="helpbody">
          {tab === 'recipes'
            ? RECIPES.map((r) => <div key={r.q} className="hitem"><b>{r.q}</b><div className="muted">{r.a}</div></div>)
            : TERMS.map((t) => <div key={t.zh} className="hitem"><b>{t.zh}<span className="faint"> · {t.en}</span></b><div className="muted">{t.what}</div></div>)}
        </div>
        <div className="acts"><button className="btn ghost" onClick={() => { onReset(); }}>重新显示所有提示卡</button><button className="btn primary" onClick={onClose}>知道了</button></div>
      </div>
    </div>
  );
}

export { Modal };
