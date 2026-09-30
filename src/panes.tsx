import { useEffect, useState, type ReactNode } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  ArrowDownToLine, ArrowUpFromLine, Archive, CloudDownload, GitBranch, GitMerge, Link2, Loader2, Pencil, Plus, Settings2, Tag as TagIcon, Trash2, Undo2, Check,
} from 'lucide-react';
import { git, type Blame, type Branch, type Commit, type DiffResult, type NameStatus, type ReflogEntry, type Remote, type Snapshot, type Stash, type Tag } from './api';
import { DiffView, Modal, VirtualList } from './ui';
import { Explain } from './help';

export type Msg = { kind: 'ok' | 'err' | 'info'; text: string; action?: { label: string; run: () => void } };
export interface Ctx {
  cur: string; snap: Snapshot; rev: number; busy: string | null;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  refresh: (silent?: boolean) => Promise<void>;
  flash: (m: Msg) => void;
  fail: (e: unknown) => void;
  diffMode: 'unified' | 'split';
  openHistory: () => void;
  openChanges: () => void;
}

const msgOf = (e: unknown) => String((e as Error)?.message ?? e);
const KIND: Record<string, string> = { A: '新', M: '改', D: '删', R: '名', C: '复' };
const dateOf = (s: string) => { const d = new Date(s); return isNaN(+d) ? s : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const Empty = ({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) => <div className="center"><span className="ico" style={{ display: 'grid' }}>{icon}</span><h2>{title}</h2>{children}</div>;
/** 让“操作 → 无论成败都刷新”：合并、拉取失败时也能看到冲突横幅。 */
const settle = async (ctx: Ctx, fn: () => Promise<void>) => {
  try { await fn(); } catch (e) { await ctx.refresh(true); if (msgOf(e).includes('冲突')) ctx.openChanges(); throw e; }
  await ctx.refresh(true);
};

/** 单个文件的差异（暂存栈、追溯等独立场景使用）。 */
export function FileDiff({ ctx, file, mode, sha, old }: { ctx: Ctx; file: string; mode: string; sha: string; old?: string | null }) {
  const [d, setD] = useState<DiffResult | null>(null); const [err, setErr] = useState(''); const [large, setLarge] = useState(false);
  useEffect(() => { setLarge(false); }, [file, sha]);
  useEffect(() => {
    let dead = false; setD(null); setErr('');
    git<DiffResult>('diff', ctx.cur, { file, mode, sha, old: old ?? null, large }).then((x) => { if (!dead) setD(x); }).catch((e) => { if (!dead) setErr(msgOf(e).split('\n')[0]); });
    return () => { dead = true; };
  }, [ctx.cur, file, mode, sha, old, large]);
  if (err) return <div className="center"><p>{err}</p></div>;
  if (!d) return <div className="center"><Loader2 className="spin" /></div>;
  if (d.binary) return <div className="center"><h2>此文件不支持文本差异预览</h2><p>Word、PDF、图片等文件无法逐行对比。</p></div>;
  return <>{d.limited && !large && <div className="banner warn">文件较大，目前只显示前一部分。<span className="sp" /><button className="btn small" onClick={() => setLarge(true)}>继续加载</button></div>}<DiffView text={d.text} mode={ctx.diffMode} /></>;
}

/* ------------------------------------------------------------------ 分支与标签 */
type BModal =
  | { kind: 'create'; switch: boolean } | { kind: 'rename'; name: string } | { kind: 'delete'; name: string } | { kind: 'force'; name: string }
  | { kind: 'merge'; name: string } | { kind: 'dirty'; name: string } | { kind: 'orphan'; name: string }
  | { kind: 'tag' } | { kind: 'tagDelete'; name: string } | null;

export function useBranches(ctx: Ctx, active: boolean) {
  const { cur, snap, rev, run, refresh, flash, fail } = ctx;
  const [branches, setBranches] = useState<Branch[]>([]); const [tags, setTags] = useState<Tag[]>([]);
  const [sel, setSel] = useState<{ kind: 'branch' | 'tag'; name: string } | null>(null);
  const [modal, setModal] = useState<BModal>(null); const [text, setText] = useState(''); const [flag, setFlag] = useState(true);
  useEffect(() => {
    if (!active) return; let dead = false;
    Promise.all([git<Branch[]>('branches', cur), git<Tag[]>('tags', cur)]).then(([b, t]) => { if (!dead) { setBranches(b); setTags(t); } }).catch(fail);
    return () => { dead = true; };
  }, [active, cur, rev, fail]);
  const open = (m: BModal, initial = '') => { setText(initial); setFlag(true); setModal(m); };
  const dirty = snap.files.length > 0;
  const current = branches.find((b) => b.current);

  const doSwitch = (name: string, stash = false) => run('正在切换分支…', async () => {
    await git('branchSwitch', cur, { name, stash }); await refresh(false);
    flash({ kind: 'ok', text: `已切换到「${name}」${stash ? '。之前的修改已收进“暂存修改”，可随时取回。' : '。'}` });
  });
  const askSwitch = (name: string) => { if (snap.detached && snap.orphan > 0) open({ kind: 'orphan', name }); else if (dirty) open({ kind: 'dirty', name }); else doSwitch(name); };
  const doDelete = (name: string, force = false) => run('正在删除分支…', async () => {
    try { await git('branchDelete', cur, { name, force }); flash({ kind: 'ok', text: `已删除分支「${name}」。` }); setSel(null); await refresh(false); }
    catch (e) { if (!force && msgOf(e).includes('not fully merged')) { open({ kind: 'force', name }); return; } throw e; }
  });
  const valid = /^[^\s~^:?*[\\]+$/.test(text.trim()) && !text.trim().startsWith('-') && !text.includes('..');

  const list = (
    <>
      <Explain id="branches" title="分支是什么？">分支像一条平行的“草稿线”：想试新点子时新建一条，随便改，不影响主线；满意了再「合并」回来，不满意直接删掉。标签则是给某个版本贴上永久的名字，比如 v1.0。</Explain>
      <div className="sect" style={{ height: 40 }}><b>分支</b><span>{branches.length}</span><span className="sp" />
        <button className="btn small" title="在当前位置新建一条分支" onClick={() => open({ kind: 'create', switch: true })}><Plus size={14} />新建分支</button></div>
      <div className="list" style={{ flex: 'none', maxHeight: '55%' }}>
        {branches.map((b) => (
          <div key={b.name} className={`row brow ${sel?.kind === 'branch' && sel.name === b.name ? 'sel' : ''}`} tabIndex={0} onClick={() => setSel({ kind: 'branch', name: b.name })}
            onKeyDown={(e) => { if (e.key === 'Enter') setSel({ kind: 'branch', name: b.name }); }}>
            <GitBranch size={15} className={b.current ? 'accent' : 'faint'} />
            <span className="fname ellipsis"><b>{b.name}</b><small>{b.subject}</small></span>
            {b.track && <span className="chip">{b.track.replace('ahead', '领先').replace('behind', '落后')}</span>}
            {b.current && <span className="chip ok">当前</span>}
          </div>))}
        {branches.length === 0 && <p className="muted" style={{ padding: 16 }}>{snap.head ? '还没有分支。' : '保存第一个版本后，这里会出现主分支。'}</p>}
      </div>
      <div className="sect" style={{ height: 40 }}><b>标签</b><span>{tags.length}</span><span className="sp" />
        <button className="btn small" disabled={!snap.head} title="给当前版本贴一个永久的名字" onClick={() => open({ kind: 'tag' })}><Plus size={14} />新建标签</button></div>
      <div className="list">
        {tags.map((t) => (
          <div key={t.name} className={`row brow ${sel?.kind === 'tag' && sel.name === t.name ? 'sel' : ''}`} tabIndex={0} onClick={() => setSel({ kind: 'tag', name: t.name })}
            onKeyDown={(e) => { if (e.key === 'Enter') setSel({ kind: 'tag', name: t.name }); }}>
            <TagIcon size={15} className="faint" /><span className="fname ellipsis"><b>{t.name}</b><small>{t.subject}</small></span><span className="faint mono">{t.sha}</span>
          </div>))}
        {tags.length === 0 && <p className="muted" style={{ padding: '4px 16px' }}>还没有标签。</p>}
      </div>
    </>
  );

  const b = sel?.kind === 'branch' ? branches.find((x) => x.name === sel.name) : undefined;
  const t = sel?.kind === 'tag' ? tags.find((x) => x.name === sel.name) : undefined;
  const detail = b ? (
    <div className="detail">
      <div className="pane-head"><h2 className="ellipsis"><GitBranch size={16} style={{ verticalAlign: -2 }} /> {b.name}</h2>{b.current && <span className="chip ok">你当前在这里</span>}</div>
      <div className="dbody">
        <p className="muted">最近一次保存：<b>{b.subject || '（无说明）'}</b> <span className="mono faint">{b.sha}</span></p>
        {b.upstream && <p className="muted">对应远程分支：<span className="mono">{b.upstream}</span> {b.track && `（${b.track.replace('ahead', '领先').replace('behind', '落后')}）`}</p>}
        <div className="actions">
          <div><button className="btn primary" disabled={b.current || !!ctx.busy} onClick={() => askSwitch(b.name)}><Check size={15} />切换到这条分支</button><p className="hint">让你的文件夹变成这条分支的样子。有未保存的修改时，会先让你选择怎么处理。</p></div>
          <div><button className="btn" disabled={b.current || !!ctx.busy || !current} onClick={() => open({ kind: 'merge', name: b.name })}><GitMerge size={15} />合并到当前分支{current ? `「${current.name}」` : ''}</button><p className="hint">把这条分支上的成果并进你当前所在的分支。两边改到同一处时会提示冲突，由你决定保留谁。</p></div>
          <div><button className="btn" disabled={!!ctx.busy} onClick={() => open({ kind: 'rename', name: b.name }, b.name)}><Pencil size={15} />重命名</button></div>
          <div><button className="btn danger" disabled={b.current || !!ctx.busy} onClick={() => open({ kind: 'delete', name: b.name })}><Trash2 size={15} />删除分支</button><p className="hint">删除分支只是拿掉这个“名字”；如果里面有还没合并的版本，会先提醒你。当前所在的分支不能删除。</p></div>
        </div>
      </div>
    </div>
  ) : t ? (
    <div className="detail">
      <div className="pane-head"><h2 className="ellipsis"><TagIcon size={16} style={{ verticalAlign: -2 }} /> {t.name}</h2><span className="mono faint">{t.sha}</span></div>
      <div className="dbody"><p className="muted">{t.subject || '（没有备注）'} · {t.date}</p>
        <div className="actions"><div><button className="btn danger" onClick={() => open({ kind: 'tagDelete', name: t.name })}><Trash2 size={15} />删除标签</button><p className="hint">只删除这个名字贴纸，不会删除版本本身。</p></div></div></div>
    </div>
  ) : <Empty icon={<GitBranch size={44} />} title="选一个分支或标签"><p>在左侧点选，就能切换、合并、重命名或删除。不确定时不用担心——每一步都会先说明会发生什么。</p></Empty>;

  const close = () => setModal(null);
  const overlay = modal && (
    modal.kind === 'create' ? <Modal title="新建分支" onClose={close} actions={<><button className="btn" onClick={close}>取消</button>
      <button className="btn primary" disabled={!valid} onClick={() => { const name = text.trim(); const sw = flag; close(); run('正在创建分支…', async () => { await git('branchCreate', cur, { name, switch: sw }); await refresh(false); flash({ kind: 'ok', text: sw ? `已创建并切换到「${name}」。` : `已创建分支「${name}」。` }); }); }}>创建</button></>}>
      <p className="muted">新分支从你现在所在的位置开始，之后的保存互不影响。名字不要有空格，可以用中文，如：试写新结局。</p>
      <div className="field"><label htmlFor="bn">分支名称</label><input id="bn" type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="例如：试写新结局" /></div>
      <label className="check"><input type="checkbox" checked={flag} onChange={(e) => setFlag(e.target.checked)} />创建后立即切换过去（未保存的修改会一起带过去）</label>
    </Modal>
    : modal.kind === 'rename' ? <Modal title={`重命名「${modal.name}」`} onClose={close} actions={<><button className="btn" onClick={close}>取消</button>
      <button className="btn primary" disabled={!valid || text.trim() === modal.name} onClick={() => { const name = modal.name, nn = text.trim(); close(); run('正在重命名…', async () => { await git('branchRename', cur, { name, newName: nn }); await refresh(false); setSel({ kind: 'branch', name: nn }); flash({ kind: 'ok', text: `已重命名为「${nn}」。` }); }); }}>重命名</button></>}>
      <div className="field"><label htmlFor="rn">新名称</label><input id="rn" type="text" value={text} onChange={(e) => setText(e.target.value)} /></div>
    </Modal>
    : modal.kind === 'delete' ? <Modal title={`删除分支「${modal.name}」？`} onClose={close} actions={<><button className="btn" onClick={close}>取消</button><button className="btn danger solid" onClick={() => { const n = modal.name; close(); doDelete(n); }}>删除</button></>}>
      <p>这只会拿掉分支的名字。已经合并过的内容不受影响；如果这条分支上还有没合并的版本，下一步会再提醒你。</p></Modal>
    : modal.kind === 'force' ? <Modal title="这条分支还有未合并的版本" onClose={close} actions={<><button className="btn" onClick={close}>保留分支</button><button className="btn danger solid" onClick={() => { const n = modal.name; close(); doDelete(n, true); }}>仍然删除</button></>}>
      <p>分支「{modal.name}」上有还没合并进其他分支的版本。<b style={{ color: 'var(--removed-ink)' }}>删除后这些版本会很难找回</b>（只能通过“操作记录”）。确定要删除吗？</p></Modal>
    : modal.kind === 'merge' ? <Modal title={`合并「${modal.name}」到「${snap.branch || '当前位置'}」`} onClose={close} actions={<><button className="btn" onClick={close}>取消</button>
      <button className="btn primary" disabled={dirty || snap.detached} onClick={() => { const n = modal.name; close(); run('正在合并…', () => settle(ctx, async () => { await git('merge', cur, { name: n }); flash({ kind: 'ok', text: `已把「${n}」合并进当前分支。` }); })); }}>开始合并</button></>}>
      <p>把「{modal.name}」上的成果并进你当前所在的分支「{snap.branch}」。</p>
      {dirty ? <p className="banner warn" style={{ margin: 0 }}>你还有未保存的修改。请先「保存版本」，或到「暂存修改」里收起来，再合并。</p>
        : snap.detached ? <p className="banner warn" style={{ margin: 0 }}>你当前不在任何分支上，请先切换到一条分支。</p>
        : <p className="muted">如果两边改到了同一处，会出现冲突，我会带你逐个处理；随时可以点“中止操作”回到合并前。</p>}
    </Modal>
    : modal.kind === 'dirty' ? <Modal title="你还有未保存的修改" onClose={close} actions={<><button className="btn" onClick={close}>取消</button>
      <button className="btn primary" onClick={() => { const n = modal.name; close(); doSwitch(n, true); }}>先收进“暂存修改”，再切换</button></>}>
      <p>切换分支会改变文件夹里的文件。为了不丢内容，可以先把当前修改（包括新文件）收进“暂存修改”，切换后随时在「暂存修改」页取回。</p>
      <p className="muted">或者取消，回到「修改」页先保存版本。</p></Modal>
    : modal.kind === 'orphan' ? <Modal title="你现在不在任何分支上" onClose={close} actions={<><button className="btn" onClick={close}>取消</button>
      <button className="btn" onClick={() => { close(); open({ kind: 'create', switch: true }, ''); }}>先在此创建分支</button>
      <button className="btn danger solid" onClick={() => { const n = modal.name; close(); if (dirty) open({ kind: 'dirty', name: n }); else doSwitch(n); }}>仍然切换</button></>}>
      <p>最近有 <b>{snap.orphan}</b> 个版本不属于任何分支。直接切走后，它们会变得很难找回。</p>
      <p className="muted">建议先「在此创建分支」，把这些版本保住。</p></Modal>
    : modal.kind === 'tag' ? <Modal title="给当前版本贴标签" onClose={close} actions={<><button className="btn" onClick={close}>取消</button>
      <button className="btn primary" disabled={!valid} onClick={() => { const name = text.trim(); close(); run('正在创建标签…', async () => { await git('tagCreate', cur, { name, message: '' }); await refresh(false); flash({ kind: 'ok', text: `已创建标签「${name}」。` }); }); }}>创建</button></>}>
      <p className="muted">标签是贴在某个版本上的永久名字，比如“v1.0 定稿”。</p>
      <div className="field"><label htmlFor="tn">标签名称</label><input id="tn" type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="例如：v1.0" /></div>
    </Modal>
    : <Modal title={`删除标签「${modal.name}」？`} onClose={close} actions={<><button className="btn" onClick={close}>取消</button><button className="btn danger solid" onClick={() => { const n = modal.name; close(); run('正在删除标签…', async () => { await git('tagDelete', cur, { name: n }); setSel(null); await refresh(false); flash({ kind: 'ok', text: '已删除标签。' }); }); }}>删除</button></>}>
      <p>只删除名字贴纸，不会删除版本本身。</p></Modal>
  );
  return { list, detail, overlay };
}

/* ------------------------------------------------------------------ 暂存修改 */
export function useStash(ctx: Ctx, active: boolean) {
  const { cur, snap, rev, run, refresh, flash, fail } = ctx;
  const [items, setItems] = useState<Stash[]>([]); const [sel, setSel] = useState<Stash | null>(null);
  const [files, setFiles] = useState<NameStatus[]>([]); const [file, setFile] = useState<NameStatus | null>(null);
  const [modal, setModal] = useState<'create' | 'drop' | null>(null); const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!active) return; let dead = false;
    git<Stash[]>('stashes', cur).then((s) => { if (!dead) { setItems(s); setSel((o) => s.find((x) => x.sha === o?.sha) ?? null); } }).catch(fail);
    return () => { dead = true; };
  }, [active, cur, rev, fail]);
  useEffect(() => {
    setFiles([]); setFile(null); if (!sel) return; let dead = false;
    git<NameStatus[]>('stashFiles', cur, { sha: sel.sha }).then((f) => { if (!dead) { setFiles(f); setFile(f[0] ?? null); } }).catch(fail);
    return () => { dead = true; };
  }, [sel?.sha, cur, fail]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = snap.files.length > 0;
  const apply = (drop: boolean) => sel && run('正在恢复…', async () => { await git('stashApply', cur, { sha: sel.sha, drop }); await refresh(false); flash({ kind: 'ok', text: drop ? '已恢复修改，并从抽屉里拿掉了这条记录。' : '已恢复修改，抽屉里仍保留这条记录。' }); });

  const list = (
    <>
      <Explain id="stash" title="暂存修改是什么？">写到一半、还不想保存成版本，却要先处理别的事？把改动收进“抽屉”，文件夹立刻回到干净的样子；回来后一键取回，接着写。（它和“已准备保存”是两回事。）</Explain>
      <div className="sect" style={{ height: 40 }}><b>抽屉里的记录</b><span>{items.length}</span><span className="sp" />
        <button className="btn small" disabled={!dirty || !snap.head || !!ctx.busy} title={!snap.head ? '需要先保存第一个版本' : !dirty ? '当前没有可暂存的修改' : '把当前所有修改收进抽屉'} onClick={() => { setMsg(''); setModal('create'); }}><Archive size={14} />暂存当前修改</button></div>
      <div className="list">
        {items.map((s) => (
          <div key={s.sha} className={`row brow ${sel?.sha === s.sha ? 'sel' : ''}`} tabIndex={0} onClick={() => setSel(s)} onKeyDown={(e) => { if (e.key === 'Enter') setSel(s); }}>
            <Archive size={15} className="faint" /><span className="fname ellipsis"><b>{s.subject.replace(/^On [^:]+: /, '')}</b><small>{dateOf(s.date)}</small></span></div>))}
        {items.length === 0 && <p className="muted" style={{ padding: 16 }}>抽屉是空的。有未保存的修改时，点上面的按钮就能收进来。</p>}
      </div>
    </>
  );
  const detail = sel ? (
    <div className="detail" style={{ minHeight: 0, display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div className="pane-head"><h2 className="ellipsis">{sel.subject.replace(/^On [^:]+: /, '')}</h2>
        <button className="btn small" disabled={dirty || !!ctx.busy} title={dirty ? '请先保存或暂存当前修改，再恢复' : '取回这些修改，抽屉里保留记录'} onClick={() => apply(false)}><Undo2 size={14} />恢复</button>
        <button className="btn small primary" disabled={dirty || !!ctx.busy} title={dirty ? '请先保存或暂存当前修改，再恢复' : '取回这些修改，并清理这条记录'} onClick={() => apply(true)}>恢复并清理</button>
        <button className="btn small danger" disabled={!!ctx.busy} onClick={() => setModal('drop')}><Trash2 size={14} />丢弃</button></div>
      {dirty && <div className="banner warn">当前有未保存的修改，所以暂时不能恢复。先「保存版本」，或再把它们暂存一次。</div>}
      <div style={{ maxHeight: 132, overflow: 'auto', borderBottom: '1px solid var(--rule)' }}>
        {files.map((f) => <div key={f.path} className={`row ${file?.path === f.path ? 'sel' : ''}`} style={{ height: 30 }} tabIndex={0} onClick={() => setFile(f)} onKeyDown={(e) => { if (e.key === 'Enter') setFile(f); }}>
          <span className={`badge b-${f.status[0]}`}>{KIND[f.status[0]] ?? f.status[0]}</span><span className="fname ellipsis">{f.path}</span></div>)}
        {files.length === 0 && <p className="muted" style={{ padding: 10 }}>这条记录里只有新建的文件，或正在读取…</p>}
      </div>
      {file && <FileDiff ctx={ctx} file={file.path} mode="stash" sha={sel.sha} old={file.old} />}
    </div>
  ) : <Empty icon={<Archive size={44} />} title="抽屉里的修改"><p>在左侧选一条记录，可以先看看里面有什么，再决定恢复还是丢弃。</p></Empty>;
  const overlay = modal === 'create' ? (
    <Modal title="暂存当前修改" onClose={() => setModal(null)} actions={<><button className="btn" onClick={() => setModal(null)}>取消</button>
      <button className="btn primary" onClick={() => { const m = msg; setModal(null); run('正在暂存…', async () => { await git('stashCreate', cur, { message: m }); await refresh(false); flash({ kind: 'ok', text: '修改已收进抽屉，文件夹回到了干净的样子。' }); }); }}>暂存</button></>}>
      <p className="muted">会把所有未保存的修改（包括新建的文件）收起来。之后可在这里取回。</p>
      <div className="field"><label htmlFor="sm">备注（可选）</label><input id="sm" type="text" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="例如：第三章写到一半" /></div>
    </Modal>
  ) : modal === 'drop' && sel ? (
    <Modal title="丢弃这条暂存记录？" onClose={() => setModal(null)} actions={<><button className="btn" onClick={() => setModal(null)}>取消</button>
      <button className="btn danger solid" onClick={() => { const s = sel; setModal(null); run('正在丢弃…', async () => { await git('stashDrop', cur, { sha: s.sha }); setSel(null); await refresh(false); flash({ kind: 'ok', text: '已丢弃这条记录。' }); }); }}>丢弃</button></>}>
      <p>这条记录里的修改会<b style={{ color: 'var(--removed-ink)' }}>永久丢失</b>（如果还没有恢复过）。确定吗？</p></Modal>
  ) : null;
  return { list, detail, overlay };
}

/* ------------------------------------------------------------------ 同步条 */
export function SyncBar({ ctx }: { ctx: Ctx }) {
  const { cur, snap, run, refresh, flash, busy } = ctx;
  const [remotes, setRemotes] = useState<Remote[]>([]); const [modal, setModal] = useState(false);
  const [name, setName] = useState('origin'); const [url, setUrl] = useState('');
  const [mode, setMode] = useState<string>(() => localStorage.getItem('pg-pull') ?? 'merge');
  useEffect(() => { let dead = false; git<Remote[]>('remotes', cur).then((r) => { if (!dead) setRemotes(r); }).catch(() => undefined); return () => { dead = true; }; }, [cur, snap.remotes.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const remote = snap.upstream.includes('/') ? snap.upstream.split('/')[0] : remotes[0]?.name;
  const dirty = snap.files.length > 0;
  const noBranch = !snap.branch;
  const op = (label: string, fn: () => Promise<void>) => run(label, () => settle(ctx, fn));

  const status = remotes.length === 0 ? '还没有连接远程仓库：连接后，可以把版本备份到网上，也能和别人协作。'
    : !snap.head ? '先保存第一个版本，再上传。'
    : noBranch ? '当前不在任何分支上，无法同步。'
    : !snap.upstream ? `远程「${remote}」还没有分支「${snap.branch}」，第一次点“上传”会建立它。`
    : snap.ahead === 0 && snap.behind === 0 ? `与远程「${snap.upstream}」保持一致。`
    : `${snap.ahead ? `本地有 ${snap.ahead} 个版本还没上传` : ''}${snap.ahead && snap.behind ? '；' : ''}${snap.behind ? `远程有 ${snap.behind} 个新版本还没拉取` : ''}。`;

  return (
    <div className="syncbar" role="region" aria-label="远程同步">
      <span className="ellipsis sync-text" title={status}>{status}</span>
      {remotes.length > 0 && snap.upstream && <>
        <span className="chip" title="本地领先远程的版本数（还没上传）"><ArrowUpFromLine size={12} />{snap.ahead}</span>
        <span className="chip" title="本地落后远程的版本数（还没拉取）"><ArrowDownToLine size={12} />{snap.behind}</span></>}
      {remotes.length === 0
        ? <button className="btn small primary" onClick={() => { setName('origin'); setUrl(''); setModal(true); }}><Link2 size={14} />连接远程仓库…</button>
        : <>
          <button className="btn small" disabled={!!busy || !remote} title="获取更新（Fetch）：只查看远程有什么新东西，不改你的文件，很安全" onClick={() => op('正在获取远程更新…', async () => { await git('fetch', cur, { remote }); flash({ kind: 'ok', text: '已获取远程最新信息。' }); })}><CloudDownload size={14} />获取更新</button>
          <button className="btn small" disabled={!!busy || !remote || !snap.upstream || dirty || noBranch} title={dirty ? '有未保存的修改：请先保存版本或暂存修改，再拉取' : '拉取（Pull）：把远程的新版本合并进当前分支'} onClick={() => op('正在拉取…', async () => { await git('pull', cur, { remote, mode }); flash({ kind: 'ok', text: '已拉取并合并远程更新。' }); })}><ArrowDownToLine size={14} />拉取{snap.behind ? ` ${snap.behind}` : ''}</button>
          <button className="btn small primary" disabled={!!busy || !remote || !snap.head || noBranch || (!!snap.upstream && snap.ahead === 0)} title="上传（Push）：把本机保存的版本送到远程。本应用永不强制上传" onClick={() => op('正在上传…', async () => { await git('push', cur, { remote }); flash({ kind: 'ok', text: `已上传到远程「${remote}」。` }); })}><ArrowUpFromLine size={14} />上传{snap.ahead ? ` ${snap.ahead}` : ''}</button>
          <button className="btn small icon ghost" aria-label="远程设置" title="远程设置" onClick={() => { setName(remotes[0]?.name ?? 'origin'); setUrl(remotes[0]?.url ?? ''); setModal(true); }}><Settings2 size={15} /></button></>}
      {modal && (
        <Modal title={remotes.length ? '远程设置' : '连接远程仓库'} onClose={() => setModal(false)} actions={<>
          {remotes.length > 0 && <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => { const n = name; setModal(false); run('正在断开…', async () => { await git('remoteRemove', cur, { name: n }); await refresh(false); flash({ kind: 'ok', text: '已断开远程（不影响本地版本）。' }); }); }}>断开连接</button>}
          <button className="btn" onClick={() => setModal(false)}>取消</button>
          <button className="btn primary" disabled={!url.trim() || !name.trim()} onClick={() => { const n = name.trim(), u = url.trim(); setModal(false); run('正在保存远程…', async () => { await git('remoteSet', cur, { name: n, url: u }); await refresh(false); flash({ kind: 'ok', text: '已连接。现在可以点“上传”把版本备份到远程。' }); }); }}>保存</button></>}>
          <p className="muted">远程仓库是放在网上的副本（GitHub、Gitee 等），用于备份和协作。先在网站上新建一个空仓库，再把它的网址粘贴到这里。</p>
          <div className="field"><label htmlFor="ru">仓库网址</label><input id="ru" type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/你的名字/仓库名.git" /></div>
          <div className="field"><label htmlFor="rname">名称（一般用 origin）</label><input id="rname" type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor="pm">拉取方式</label>
            <select id="pm" value={mode} onChange={(e) => { setMode(e.target.value); localStorage.setItem('pg-pull', e.target.value); }}>
              <option value="merge">合并（默认，最直观）</option><option value="ff">只快进（有分叉就停下提示）</option><option value="rebase">变基（历史更整齐，进阶）</option></select></div>
          <p className="faint" style={{ fontSize: 12 }}>登录由 Windows 的 Git 凭据管理器完成，本应用不会保存你的密码或令牌，网址里也不允许包含它们。</p>
        </Modal>)}
    </div>
  );
}

/* ------------------------------------------------------------------ 弹窗：回到此版本 / 标签 / 操作记录 / 追溯 / 克隆 */
export function ResetModal({ ctx, target, onClose }: { ctx: Ctx; target: { sha: string; subject: string }; onClose: () => void }) {
  const { cur, snap, run, refresh, flash } = ctx;
  const [mode, setMode] = useState<'mixed' | 'hard'>('mixed'); const [word, setWord] = useState('');
  const expect = snap.branch || 'HEAD'; const dirty = snap.files.length > 0;
  const pushed = !!snap.upstream && snap.ahead === 0;
  const can = mode === 'mixed' || (word === expect && !dirty);
  return (
    <Modal title="回到这个版本" onClose={onClose} actions={<><button className="btn" onClick={onClose}>取消</button>
      <button className={`btn ${mode === 'hard' ? 'danger solid' : 'primary'}`} disabled={!can} onClick={() => { onClose(); run('正在回退…', async () => { await git('resetTo', cur, { sha: target.sha, mode, confirm: word }); await refresh(false); flash({ kind: 'ok', text: mode === 'hard' ? '已彻底回到该版本。' : '已回到该版本，文件内容保持不变，可重新选择要保存的内容。' }); }); }}>确认回到此版本</button></>}>
      <p>目标版本：<b>{target.subject || '（无说明）'}</b> <span className="mono faint">{target.sha.slice(0, 7)}</span></p>
      <label className="radio"><input type="radio" checked={mode === 'mixed'} onChange={() => setMode('mixed')} /><span><b>保留修改（推荐）</b><br /><span className="muted">只把版本记录退回去，文件内容原样保留，之后的改动变成“未保存的修改”，可以重新整理后保存。</span></span></label>
      <label className="radio"><input type="radio" checked={mode === 'hard'} onChange={() => setMode('hard')} /><span><b style={{ color: 'var(--removed-ink)' }}>彻底回到（会丢弃之后的内容）</b><br /><span className="muted">文件夹会变成该版本当时的样子，之后保存的版本也会从这条分支上消失。</span></span></label>
      {mode === 'hard' && <div className="field"><label htmlFor="cw">为防误操作，请输入当前分支名「{expect}」确认</label><input id="cw" type="text" value={word} onChange={(e) => setWord(e.target.value)} />
        {dirty && <span style={{ color: 'var(--removed-ink)', fontSize: 12 }}>你还有未保存的修改，彻底回退会让它们消失，所以请先保存或暂存。</span>}</div>}
      {pushed && <p className="banner warn" style={{ margin: 0 }}>这些版本已经上传到远程。回退后你的本机会“落后”于远程，之后无法直接上传（本应用不提供强制上传）。</p>}
    </Modal>
  );
}

export function TagModal({ ctx, sha, onClose, onDone }: { ctx: Ctx; sha: string; onClose: () => void; onDone?: () => void }) {
  const [name, setName] = useState(''); const [msg, setMsg] = useState('');
  const ok = /^[^\s~^:?*[\\]+$/.test(name) && !name.startsWith('-') && !name.includes('..');
  return (
    <Modal title="给这个版本贴标签" onClose={onClose} actions={<><button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" disabled={!ok} onClick={() => { onClose(); ctx.run('正在创建标签…', async () => { await git('tagCreate', ctx.cur, { name, message: msg, sha }); await ctx.refresh(false); onDone?.(); ctx.flash({ kind: 'ok', text: `已创建标签「${name}」。` }); }); }}>创建</button></>}>
      <p className="muted">标签是贴在版本上的永久名字，比如“v1.0 定稿”，方便以后一眼找到。</p>
      <div className="field"><label htmlFor="tgn">标签名称</label><input id="tgn" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：v1.0" /></div>
      <div className="field"><label htmlFor="tgm">备注（可选）</label><input id="tgm" type="text" value={msg} onChange={(e) => setMsg(e.target.value)} /></div>
    </Modal>
  );
}

export function ReflogModal({ ctx, onPick, onClose }: { ctx: Ctx; onPick: (e: ReflogEntry) => void; onClose: () => void }) {
  const [items, setItems] = useState<ReflogEntry[] | null>(null);
  useEffect(() => { git<ReflogEntry[]>('reflog', ctx.cur).then(setItems).catch((e) => { ctx.fail(e); setItems([]); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="操作记录（后悔药）" onClose={onClose} actions={<button className="btn primary" onClick={onClose}>关闭</button>}>
      <p className="muted">Git 悄悄记下了你每次移动到过的位置。误操作后，可以在这里找到出问题之前的那一步，选择“回到这一步”。</p>
      <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--rule)', borderRadius: 8 }}>
        {!items ? <div style={{ padding: 16 }}><Loader2 className="spin" /></div> : items.length === 0 ? <p className="muted" style={{ padding: 12, margin: 0 }}>还没有记录。</p>
          : items.map((e) => <div key={e.ref + e.sha} className="row" style={{ height: 'auto', padding: '7px 12px', alignItems: 'flex-start' }}>
            <span className="fname"><span className="ellipsis" style={{ display: 'block' }}>{e.subject}</span><small style={{ marginLeft: 0 }}>{dateOf(e.date)} · <span className="mono">{e.sha.slice(0, 7)}</span></small></span>
            <button className="btn small" onClick={() => onPick(e)}>回到这一步</button></div>)}
      </div>
    </Modal>
  );
}

export function BlameModal({ ctx, file, sha, onClose }: { ctx: Ctx; file: string; sha: string; onClose: () => void }) {
  const [b, setB] = useState<Blame | null>(null); const [err, setErr] = useState('');
  useEffect(() => { git<Blame>('blame', ctx.cur, { file, sha }).then(setB).catch((e) => setErr(msgOf(e).split('\n')[0])); }, [ctx.cur, file, sha]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal blamebox" role="dialog" aria-modal="true" aria-label="逐行追溯">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><h3 style={{ flex: 1 }} className="ellipsis">逐行追溯 · {file}</h3><button className="btn small" onClick={onClose}>关闭</button></div>
        <p className="muted" style={{ fontSize: 12 }}>每一行左侧显示：最后是谁、在哪次保存里改了它。</p>
        {err ? <p>{err}</p> : !b ? <Loader2 className="spin" /> : <>
          {b.limited && <p className="banner warn" style={{ margin: 0 }}>文件较长，只显示前 3000 行（共 {b.total} 行）。</p>}
          <div className="blame"><VirtualList items={b.rows} rowHeight={22} render={(r, i) => (
            <div className="bl" key={i} title={`${r.summary}\n${r.author}`}>
              <span className="who">{i > 0 && b.rows[i - 1].sha === r.sha ? '' : `${r.author}`}</span>
              <span className="when mono">{i > 0 && b.rows[i - 1].sha === r.sha ? '' : `${r.sha} · ${new Date(+r.time * 1000).toLocaleDateString('zh-CN')}`}</span>
              <span className="code mono">{r.text}</span></div>)} /></div></>}
      </div>
    </div>
  );
}

export function CloneModal({ onClose, onCloned, run, flash }: { onClose: () => void; onCloned: (path: string) => void; run: Ctx['run']; flash: Ctx['flash'] }) {
  const [url, setUrl] = useState(''); const [dir, setDir] = useState(''); const [name, setName] = useState(''); const [touched, setTouched] = useState(false);
  const guess = (u: string) => u.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).pop()?.replace(/\.git$/, '') ?? '';
  const ok = url.trim() && dir && name.trim();
  return (
    <Modal title="从网址克隆仓库" onClose={onClose} actions={<><button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" disabled={!ok} onClick={() => { onClose(); run('正在克隆…（大仓库可能需要几分钟）', async () => { const r = await git<{ path: string }>('clone', dir, { url: url.trim(), name: name.trim() }); onCloned(r.path); flash({ kind: 'ok', text: '克隆完成，已添加到仓库列表。' }); }); }}>开始克隆</button></>}>
      <p className="muted">把网上（GitHub、Gitee 等）已有的仓库完整下载到你的电脑。需要登录时，会由 Windows 的 Git 凭据管理器弹窗。</p>
      <div className="field"><label htmlFor="cu">仓库网址</label><input id="cu" type="text" value={url} placeholder="https://github.com/名字/仓库.git" onChange={(e) => { setUrl(e.target.value); if (!touched) setName(guess(e.target.value)); }} /></div>
      <div className="field"><label>保存到</label><div style={{ display: 'flex', gap: 8 }}><input type="text" readOnly value={dir} placeholder="选择一个文件夹" aria-label="保存位置" />
        <button className="btn" onClick={async () => { const p = await openDialog({ directory: true, multiple: false, title: '选择保存位置' }); if (typeof p === 'string') setDir(p); }}>浏览…</button></div></div>
      <div className="field"><label htmlFor="cn">文件夹名称</label><input id="cn" type="text" value={name} onChange={(e) => { setName(e.target.value); setTouched(true); }} /></div>
    </Modal>
  );
}

export { Plus };
export type { Commit };
