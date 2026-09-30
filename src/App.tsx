import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  AlertTriangle, Check, CheckCircle2, Download, ExternalLink, FolderGit2, FolderPlus, GitBranch, History,
  Loader2, RefreshCw, Save, Undo2, X, FileText, FolderX, GitFork, Minus, Moon, Search, Square, Sun, HelpCircle, Copy, Tag as TagIcon, FileSearch, RotateCcw, Link2,
} from 'lucide-react';
import {
  git, watchProject, initialPath, cancelTasks, norm, baseName,
  type Commit, type DiffResult, type FileEntry, type Inspect, type NameStatus, type Project, type Snapshot, type Staged,
} from './api';
import { DiffView, Modal, VirtualList, type HunkAction } from './ui';
import { Explain, HelpModal, resetHints } from './help';
import { BlameModal, CloneModal, ReflogModal, ResetModal, SyncBar, TagModal, useBranches, useStash, type Ctx } from './panes';

type Msg = { kind: 'ok' | 'err' | 'info'; text: string; action?: { label: string; run: () => void } };
type Group = 'staged' | 'unstaged' | 'conflict';
type Sel = { path: string; group: Group };
type ModalState =
  | { kind: 'identity'; commitAfter: boolean }
  | { kind: 'discard'; file: FileEntry; token: string; added: number; removed: number }
  | { kind: 'revert'; commit: Commit }
  | { kind: 'remove'; project: Project }
  | { kind: 'undoLast' }
  | { kind: 'error'; text: string }
  | null;
type Item = { type: 'head'; group: Group; count: number } | { type: 'file'; group: Group; f: FileEntry };

const KIND: Record<string, string> = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', '?': '新增', U: '冲突', T: '类型变化' };
const PAGE = 50;
const EMPTY_SNAP: Snapshot = { files: [], branch: '', head: '', detached: false, orphan: 0, operation: '', upstream: '', ahead: 0, behind: 0, remotes: [], name: '', email: '' };

/** 把 “HEAD -> main, origin/main, tag: v1” 变成小标签。 */
function refChips(refs: string) {
  const items = refs.split(', ').map((r) => r.trim()).filter(Boolean).slice(0, 3);
  return items.map((r) => { const tag = r.startsWith('tag: '); const cur = r.startsWith('HEAD -> '); const label = r.replace('tag: ', '').replace('HEAD -> ', ''); return <span key={r} className={`refchip ${tag ? 'tag' : cur ? 'cur' : ''}`}>{label}</span>; });
}
const isStaged = (f: FileEntry) => !f.conflict && f.index !== ' ' && f.index !== '?';
const isUnstaged = (f: FileEntry) => !f.conflict && f.worktree !== ' ';
const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0];
const sameDir = (a: string, b: string) => norm(a) === norm(b);
const fmtDate = (iso: string) => {
  const d = new Date(iso); if (isNaN(+d)) return iso;
  const y = d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleString('zh-CN', { year: y ? 'numeric' : undefined, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function Badge({ code }: { code: string }) {
  const c = code === '?' ? 'A' : code === '!' ? 'X' : code;
  return <span className={`badge b-${c}`} title={code === '!' ? '冲突' : KIND[code] ?? code}>{code === '?' ? '新' : code === '!' ? '!' : (KIND[code] ?? code)[0]}</span>;
}

function Center({ icon, tone, title, children }: { icon: ReactNode; tone?: 'ok' | 'err'; title: string; children?: ReactNode }) {
  return <div className="center"><span className={`ico ${tone ?? ''}`} style={{ display: 'grid' }}>{icon}</span><h2>{title}</h2>{children}</div>;
}

export default function App() {
  const [env, setEnv] = useState<{ available: boolean; git: string } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [info, setInfo] = useState<Inspect | null>(null);
  const [projErr, setProjErr] = useState('');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'changes' | 'history' | 'branches' | 'stash'>('changes');
  const [sel, setSel] = useState<Sel | null>(null);
  const [message, setMessage] = useState('');
  const [msg, setMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [diffMode, setDiffMode] = useState<'unified' | 'split'>('unified');
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffErr, setDiffErr] = useState('');
  const [large, setLarge] = useState(false);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [more, setMore] = useState(false);
  const [histFile, setHistFile] = useState('');
  const [histSel, setHistSel] = useState<Commit | null>(null);
  const [histFiles, setHistFiles] = useState<NameStatus[]>([]);
  const [histFileSel, setHistFileSel] = useState<NameStatus | null>(null);
  const [rev, setRev] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [reflogOpen, setReflogOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<{ sha: string; subject: string } | null>(null);
  const [tagTarget, setTagTarget] = useState<string | null>(null);
  const [blameTarget, setBlameTarget] = useState<{ file: string; sha: string } | null>(null);
  const [amend, setAmend] = useState(false);
  const [histQ, setHistQ] = useState(''); const [histQd, setHistQd] = useState('');
  const [histMode, setHistMode] = useState<'message' | 'author'>('message');
  useEffect(() => { const t = window.setTimeout(() => setHistQd(histQ), 300); return () => window.clearTimeout(t); }, [histQ]);
  const [widths, setWidths] = useState<[number, number]>(() => {
    try { const w = JSON.parse(localStorage.getItem('pg-widths') ?? ''); if (Array.isArray(w)) return [w[0], w[1]]; } catch { /* 使用默认值 */ }
    return [210, 320];
  });

  const gen = useRef(0);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('pg-theme') === 'dark' ? 'dark' : 'light'));
  const [palette, setPalette] = useState(false);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('pg-theme', theme); }, [theme]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const curRef = useRef<string | null>(null);
  curRef.current = cur;
  const timer = useRef<number>(0);
  const repoRef = useRef(false);

  // ---------- 通用 ----------
  const flash = useCallback((m: Msg) => {
    setMsg(m);
    if (m.kind === 'ok') { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setMsg((x) => (x === m ? null : x)), 8000); }
  }, []);
  const fail = useCallback((e: unknown) => {
    const full = String((e as Error)?.message ?? e);
    const lines = full.split('\n').filter(Boolean);
    const text = lines[0] === 'Git 操作失败。' && lines[1] ? lines[1] : lines[0] ?? '操作失败';
    flash({ kind: 'err', text, action: full.includes('\n') ? { label: '详情', run: () => setModal({ kind: 'error', text: full }) } : undefined });
  }, [flash]);
  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); } catch (e) { fail(e); } finally { setBusy(null); }
  }, [fail]);

  const persist = (list: Project[]) => { setProjects(list); git('saveProjects', undefined, { projects: list }).catch(fail); };

  // ---------- 仓库状态 ----------
  const refresh = useCallback(async (silent = true) => {
    const path = curRef.current; if (!path || !repoRef.current) return;
    const g = gen.current;
    try {
      const s = await git<Snapshot>('status', path);
      if (g !== gen.current) return;
      setSnap(s); setRev((r) => r + 1);
      const st = s.files.some(isStaged) ? await git<Staged>('prepareCommit', path) : null;
      if (g !== gen.current) return;
      setStaged(st);
      setSel((old) => {
        const has = (x: Sel) => s.files.some((f) => f.path === x.path && (x.group === 'conflict' ? f.conflict : x.group === 'staged' ? isStaged(f) : isUnstaged(f)));
        if (old && has(old)) return old;
        const f = s.files.find((x) => x.conflict) ?? s.files.find(isStaged) ?? s.files.find(isUnstaged);
        return f ? { path: f.path, group: f.conflict ? 'conflict' : isUnstaged(f) ? 'unstaged' : 'staged' } : null;
      });
    } catch (e) { if (g === gen.current && !silent) fail(e); }
  }, [fail]);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;

  const loadProject = useCallback(async (path: string) => {
    const g = ++gen.current;
    repoRef.current = false; setInfo(null); setProjErr(''); setSnap(null); setStaged(null); setSel(null); setDiff(null);
    setCommits([]); setHistSel(null); setHistFiles([]); setHistFile(''); setMessage(''); setView('changes'); setAmend(false); setHistQ('');
    setLoading(true);
    try {
      const i = await git<Inspect>('inspect', path);
      if (g !== gen.current) return;
      setInfo(i);
      if (i.repository && sameDir(i.repository, i.path)) { repoRef.current = true; await refresh(false); await watchProject(path); }
      else await watchProject(null);
    } catch (e) { if (g === gen.current) { setProjErr(firstLine(e)); await watchProject(null); } }
    finally { if (g === gen.current) setLoading(false); }
  }, [refresh]);

  const isRepo = !!info && !!info.repository && sameDir(info.repository, info.path);
  repoRef.current = isRepo;

  useEffect(() => { if (cur) loadProject(cur); else { gen.current++; setInfo(null); setSnap(null); watchProject(null); } }, [cur, loadProject]);

  // ---------- 启动、事件 ----------
  const projectsRef = useRef(projects); projectsRef.current = projects;
  const openPath = useCallback(async (raw: string) => {
    try {
      const i = await git<Inspect>('inspect', raw);
      const list = projectsRef.current;
      if (!list.some((p) => sameDir(p.path, i.path))) persist([{ path: i.path, name: baseName(i.path) }, ...list].slice(0, 50));
      setCur(i.path);
    } catch (e) { fail(e); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fail]);
  const openRef = useRef(openPath); openRef.current = openPath;

  useEffect(() => {
    (async () => {
      try {
        const e = await git<{ git: string; available: boolean }>('environment');
        setEnv(e);
        const list = await git<Project[]>('projects');
        setProjects(list);
        const arg = await initialPath();
        if (arg) await openRef.current(arg); else if (list[0]) setCur(list[0].path);
      } catch (e) { setEnv({ available: false, git: '' }); fail(e); }
    })();
    let t = 0;
    const later = () => { window.clearTimeout(t); t = window.setTimeout(() => { if (!document.hidden) refreshRef.current(); }, 250); };
    const subs = [listen('repository-changed', later), listen<string>('open-path', (e) => openRef.current(e.payload))];
    window.addEventListener('focus', later);
    document.addEventListener('visibilitychange', later);
    return () => {
      window.removeEventListener('focus', later); document.removeEventListener('visibilitychange', later);
      subs.forEach((p) => p.then((u) => u())); window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 差异 ----------
  const target = useMemo(() => {
    if (view === 'changes') {
      const f = sel && snap?.files.find((x) => x.path === sel.path); if (!f || !sel) return null;
      const mode = sel.group === 'staged' ? 'index' : f.index === '?' ? 'untracked' : 'worktree';
      return { file: f.path, old: sel.group === 'staged' ? f.old : null, mode, sha: '', key: `${f.index}${f.worktree}`, deleted: (sel.group === 'staged' ? f.index : f.worktree) === 'D' };
    }
    if (!histSel || !histFileSel) return null;
    return { file: histFileSel.path, old: histFileSel.old ?? null, mode: 'history', sha: histSel.sha, key: histSel.sha, deleted: histFileSel.status.startsWith('D') };
  }, [view, sel, snap, histSel, histFileSel]);

  useEffect(() => { setLarge(false); }, [target?.file, target?.mode, target?.sha, cur]);
  const targetKey = target ? `${cur}|${target.file}|${target.mode}|${target.sha}|${target.key}|${large}` : '';
  useEffect(() => {
    if (!target || !cur) { setDiff(null); setDiffErr(''); return; }
    const g = gen.current; let dead = false;
    setDiffLoading(true); setDiffErr('');
    git<DiffResult>('diff', cur, { file: target.file, old: target.old, mode: target.mode === 'worktree' ? '' : target.mode, sha: target.sha, large })
      .then((d) => { if (!dead && g === gen.current) setDiff(d); })
      .catch((e) => { if (!dead && g === gen.current) { setDiff(null); setDiffErr(firstLine(e)); } })
      .finally(() => { if (!dead) setDiffLoading(false); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  // ---------- 历史 ----------
  const loadHistory = useCallback(async (reset: boolean) => {
    if (!cur) return;
    const g = gen.current;
    try {
      const page = await git<Commit[]>('history', cur, { skip: reset ? 0 : commits.length, file: histFile, q: histQd, mode: histMode });
      if (g !== gen.current) return;
      setCommits((old) => (reset ? page : [...old, ...page])); setMore(page.length === PAGE);
    } catch (e) { fail(e); }
  }, [cur, commits.length, histFile, histQd, histMode, fail]);
  useEffect(() => { if (view === 'history' && isRepo) { setHistSel(null); setHistFiles([]); loadHistory(true); } /* eslint-disable-next-line */ }, [view, histFile, isRepo, snap?.head, histQd, histMode]);
  useEffect(() => {
    setHistFiles([]); setHistFileSel(null);
    if (!histSel || !cur) return;
    const g = gen.current;
    git<NameStatus[]>('commitFiles', cur, { sha: histSel.sha }).then((f) => { if (g === gen.current) { setHistFiles(f); setHistFileSel(f[0] ?? null); } }).catch(fail);
  }, [histSel, cur, fail]);

  // ---------- 操作 ----------
  const project = projects.find((p) => cur && sameDir(p.path, cur));
  const files = snap?.files ?? [];
  const conflicts = files.filter((f) => f.conflict);
  const stagedFiles = files.filter(isStaged);
  const unstagedFiles = files.filter(isUnstaged);

  const chooseFolder = async () => {
    const p = await openDialog({ directory: true, multiple: false, title: '选择要管理版本的文件夹' });
    if (typeof p === 'string') await openPath(p);
  };
  const stage = (paths: string[], on: boolean) => run(on ? '正在准备保存…' : '正在取消…', async () => {
    await git(on ? 'stage' : 'unstage', cur!, { files: paths }); await refresh(false);
  });
  const amendOk = !!snap?.head && !(snap.upstream && snap.ahead === 0);
  const toggleAmend = (on: boolean) => {
    setAmend(on); if (!on) { setMessage(''); return; }
    git<Commit[]>('history', cur!, { skip: 0 }).then((c) => { if (c[0]) setMessage(c[0].body ? `${c[0].subject}\n\n${c[0].body}` : c[0].subject); }).catch(fail);
  };
  const doCommit = () => {
    if (!snap || (!amend && !staged)) return;
    if (!snap.name || !snap.email) { setModal({ kind: 'identity', commitAfter: true }); return; }
    run(amend ? '正在更新上一次保存…' : '正在保存版本…', async () => {
      const st = staged ?? await git<Staged>('prepareCommit', cur!);
      const r = await git<{ sha: string }>('commit', cur!, { message, token: st.token, amend });
      setMessage(''); setAmend(false); await refresh(false);
      flash({ kind: 'ok', text: amend ? `已更新上一次保存（${r.sha.slice(0, 7)}）。` : `已保存版本 ${r.sha.slice(0, 7)}（${st.files.length} 个文件）。仅保存在本机。`, action: { label: '查看', run: () => { setView('history'); } } });
    });
  };
  const saveIdentity = (name: string, email: string, commitAfter: boolean) => run('正在保存身份…', async () => {
    await git('identity', cur!, { name, email }); setModal(null); await refresh(false);
    if (commitAfter) { const st = await git<Staged>('prepareCommit', cur!); setStaged(st); const r = await git<{ sha: string }>('commit', cur!, { message, token: st.token }); setMessage(''); await refresh(false); flash({ kind: 'ok', text: `已保存版本 ${r.sha.slice(0, 7)}。` }); }
  });
  const askDiscard = (f: FileEntry) => run('正在检查…', async () => {
    const { token } = await git<{ token: string }>('prepareDiscard', cur!, { file: f.path });
    const lines = (diff?.text ?? '').split('\n');
    setModal({ kind: 'discard', file: f, token, added: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length, removed: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length });
  });
  const createRepo = () => run('正在创建仓库…', async () => { await git('init', cur!); await loadProject(cur!); flash({ kind: 'ok', text: '仓库已创建。现在可以查看修改并保存第一个版本。' }); });
  const exportCopy = (t: NonNullable<typeof target>) => run('正在导出…', async () => {
    const dest = await saveDialog({ title: '导出此版本的副本', defaultPath: baseName(t.file) });
    if (!dest) return;
    await git('export', cur!, { sha: t.deleted ? `${t.sha}^` : t.sha, file: t.file, dest });
    flash({ kind: 'ok', text: '已导出历史副本。' });
  });
  const openFile = (p: string) => git('openFile', cur!, { file: p }).catch(fail);
  const removeProject = (p: Project) => {
    const list = projects.filter((x) => x.path !== p.path); persist(list); setModal(null);
    if (cur && sameDir(cur, p.path)) setCur(list[0]?.path ?? null);
  };

  // ---------- 分栏拖动 ----------
  const drag = (i: 0 | 1) => (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget; el.setPointerCapture(e.pointerId); el.classList.add('drag');
    const startX = e.clientX, start = widths[i];
    const move = (ev: PointerEvent) => setWidths((w) => { const n: [number, number] = [w[0], w[1]]; n[i] = Math.max(i ? 240 : 170, Math.min(i ? 520 : 320, start + ev.clientX - startX)); return n; });
    const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); setWidths((w) => { localStorage.setItem('pg-widths', JSON.stringify(w)); return w; }); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  const nudge = (i: 0 | 1) => (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const d = e.key === 'ArrowLeft' ? -16 : 16;
    setWidths((w) => { const n: [number, number] = [w[0], w[1]]; n[i] = Math.max(i ? 240 : 170, Math.min(i ? 520 : 320, n[i] + d)); localStorage.setItem('pg-widths', JSON.stringify(n)); return n; });
  };

  const ctx: Ctx = { cur: cur ?? '', snap: snap ?? EMPTY_SNAP, rev, busy, run, refresh, flash, fail, diffMode, openHistory: () => setView('history'), openChanges: () => setView('changes') };
  const branchesPane = useBranches(ctx, isRepo && !!snap && view === 'branches');
  const stashPane = useStash(ctx, isRepo && !!snap && view === 'stash');
  const resolve = (side: 'ours' | 'theirs') => run('正在处理冲突…', async () => { await git('resolve', cur!, { file: sel!.path, side }); await refresh(false); flash({ kind: 'ok', text: side === 'ours' ? '已保留我的版本，并标记为已解决。' : '已采用对方的版本，并标记为已解决。' }); });

  // ---------- 渲染：整体状态 ----------
  if (!env) return <Shell><div className="center"><Loader2 className="ico spin" /><p>正在启动…</p></div></Shell>;
  if (!env.available) {
    return (
      <Shell><Center icon={<AlertTriangle size={44} />} tone="err" title="没有找到 Git">
        <p>纸笺 Git 使用你电脑上的 Git for Windows 保存版本。请安装后重新检测；安装过程需要联网，之后的本地版本管理无需联网。</p>
        <div className="pathbox">https://git-scm.com/download/win</div>
        <button className="btn primary" onClick={() => git<{ git: string; available: boolean }>('environment').then(setEnv)}><RefreshCw size={15} />重新检测</button>
      </Center></Shell>
    );
  }

  const selFile = sel && files.find((f) => f.path === sel.path);
  const items: Item[] = [];
  if (conflicts.length) { items.push({ type: 'head', group: 'conflict', count: conflicts.length }); conflicts.forEach((f) => items.push({ type: 'file', group: 'conflict', f })); }
  if (stagedFiles.length) { items.push({ type: 'head', group: 'staged', count: stagedFiles.length }); stagedFiles.forEach((f) => items.push({ type: 'file', group: 'staged', f })); }
  if (unstagedFiles.length) { items.push({ type: 'head', group: 'unstaged', count: unstagedFiles.length }); unstagedFiles.forEach((f) => items.push({ type: 'file', group: 'unstaged', f })); }

  const renderItem = (it: Item, i: number) => {
    if (it.type === 'head') {
      const title = it.group === 'conflict' ? '有冲突，需要先处理' : it.group === 'staged' ? '已准备保存' : '尚未准备保存';
      const hint = it.group === 'staged' ? 'Staged' : it.group === 'unstaged' ? 'Unstaged' : 'Conflict';
      return (
        <div className="sect" key={`h${it.group}`} style={{ height: 34 }}>
          <b>{title}</b><span>{it.count}</span><span className="faint">{hint}</span><span className="sp" />
          {it.group === 'unstaged' && <button className="btn small ghost" disabled={!!busy} onClick={() => stage(unstagedFiles.map((f) => f.path), true)}>全部准备</button>}
          {it.group === 'staged' && <button className="btn small ghost" disabled={!!busy} onClick={() => stage(stagedFiles.map((f) => f.path), false)}>全部取消</button>}
        </div>
      );
    }
    const { f, group } = it;
    const selected = sel?.path === f.path && sel.group === group;
    const code = group === 'conflict' ? '!' : group === 'staged' ? f.index : f.worktree;
    const name = f.path.split('/').pop()!; const dir = f.path.slice(0, f.path.length - name.length);
    return (
      <div key={`${group}:${f.path}`} className={`row ${selected ? 'sel' : ''}`} role="option" aria-selected={selected} tabIndex={0}
        onClick={() => setSel({ path: f.path, group })}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSel({ path: f.path, group }); } }}>
        {group !== 'conflict' && (
          <input type="checkbox" checked={group === 'staged'} disabled={!!busy} aria-label={group === 'staged' ? `取消准备 ${f.path}` : `准备保存 ${f.path}`}
            onClick={(e) => e.stopPropagation()} onChange={(e) => stage([f.path, ...(f.old ? [f.old] : [])], e.target.checked)} />
        )}
        <Badge code={code} />
        <span className="fname ellipsis" title={f.old ? `${f.old} → ${f.path}` : f.path}>{name}<small>{f.old ? `← ${f.old}` : dir}</small></span>
      </div>
    );
  };

  const canCommit = (amend ? amendOk : !!staged && staged.files.length > 0) && message.trim().length > 0 && conflicts.length === 0 && !snap?.operation && !busy;
  const clean = isRepo && snap && files.length === 0 && !snap.operation;
  const statusChip = !snap ? null
    : conflicts.length ? <span className="chip err"><AlertTriangle size={13} />存在冲突</span>
    : snap.operation ? <span className="chip warn">操作未完成</span>
    : files.length ? <span className="chip warn">{files.length} 项修改</span>
    : snap.head ? <span className="chip ok"><Check size={13} />已全部保存</span> : <span className="chip">尚无版本</span>;

  const hunkAction: HunkAction | undefined = view === 'changes' && sel && sel.group !== 'conflict' && selFile && !selFile.old && target && (target.mode === 'worktree' || target.mode === 'index')
    ? { label: sel.group === 'staged' ? '取消准备此块' : '准备此块', title: '只把这一块修改放进（或移出）下一个版本，文件里的其他修改不受影响', disabled: !!busy,
        run: (index) => run('正在处理…', async () => { await git('applyHunk', cur!, { file: sel.path, index, mode: sel.group === 'staged' ? 'unstage' : 'stage' }); await refresh(false); }) }
    : undefined;
  const renderDetail = () => {
    if (!target) {
      if (view === 'history') return <Center icon={<History size={44} />} title="选择一个历史版本"><p>左侧点选版本，可查看当时保存了哪些文件、改了什么。</p></Center>;
      if (clean) return <Center icon={<CheckCircle2 size={44} />} tone="ok" title="工作区很干净，像刚铺开的信笺。"><p>当前修改已保存，可以继续安心编辑。</p><p className="faint">文件有变化时，这里会自动出现。</p></Center>;
      if (isRepo && snap && !snap.head && files.length === 0) return <Center icon={<FileText size={44} />} title="这里还是一张白纸。"><p>把文件放进这个文件夹，就能保存第一个版本。</p></Center>;
      return <Center icon={<FileText size={44} />} title="选择一个文件"><p>在中间选一个文件，就能看到它改了什么。</p></Center>;
    }
    if (sel?.group === 'conflict' && view === 'changes') return <Center icon={<AlertTriangle size={44} />} tone="err" title="这个文件有冲突"><p>两边的修改在同一处互相冲突。点“打开文件”，找到 &lt;&lt;&lt;&lt;&lt;&lt;&lt; 与 &gt;&gt;&gt;&gt;&gt;&gt;&gt; 标记，保留想要的内容并删除标记，保存后点“标记为已解决”。</p></Center>;
    if (diffLoading && !diff) return <Center icon={<Loader2 size={44} className="spin" />} title="正在加载差异…" />;
    if (diffErr) return <Center icon={<AlertTriangle size={44} />} tone="err" title="无法显示差异"><p>{diffErr}</p></Center>;
    if (!diff) return null;
    if (diff.binary) {
      return (
        <Center icon={<FileText size={44} />} title="此文件不支持文本差异预览">
          <p>Word、PDF、图片等文件无法逐行对比，但版本记录依然会保存。</p>
          {view === 'history'
            ? <button className="btn" onClick={() => exportCopy(target)}><Download size={15} />导出此版本的副本</button>
            : !target.deleted && <button className="btn" onClick={() => openFile(target.file)}><ExternalLink size={15} />用默认程序打开</button>}
        </Center>
      );
    }
    return (
      <>
        {diff.limited && <div className="banner warn"><AlertTriangle size={15} />文件较大，目前只显示前一部分。<span className="sp" />{!large && <button className="btn small" onClick={() => setLarge(true)}>继续加载</button>}</div>}
        <DiffView text={diff.text} mode={diffMode} hunkAction={hunkAction} />
      </>
    );
  };

  const canDiscard = view === 'changes' && sel?.group === 'unstaged' && selFile && selFile.index !== '?' && !selFile.old;

  // ---------- 渲染：主体 ----------
  return (
    <div className="app">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region><Logo />纸笺 Git</div>
        <div className="tb-repo" data-tauri-drag-region>
          {project && <h1 className="ellipsis" data-tauri-drag-region>{project.name}</h1>}
          {cur && <span className="path ellipsis" data-tauri-drag-region>{cur}</span>}
        </div>
        {isRepo && snap && <span className="chip" title="当前分支 Branch"><GitBranch size={13} />{snap.branch || (snap.detached ? '游离 HEAD' : '尚无版本')}</span>}
        {statusChip}
        <div className="tb-actions">
          <button className="btn icon ghost" aria-label="刷新" title="刷新" disabled={!cur || loading} onClick={() => run('正在刷新…', () => refresh(false))}>
            <RefreshCw size={16} className={loading || busy === '正在刷新…' ? 'spin' : ''} />
          </button>
          <button className="btn small ghost" aria-label="命令面板" title="命令面板 (Ctrl+K)" onClick={() => setPalette(true)}><Search size={15} /><span className="kbd">Ctrl K</span></button>
          <button className="btn icon ghost" aria-label="使用帮助" title="使用帮助：常见场景与名词解释" onClick={() => setHelpOpen(true)}><HelpCircle size={16} /></button>
          <button className="btn icon ghost" aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'} title={theme === 'dark' ? '浅色' : '深色'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
        <WinCtl />
      </header>
      {isRepo && snap ? <SyncBar ctx={ctx} /> : <div />}

      <div className="work" style={{ gridTemplateColumns: `${widths[0]}px 5px ${widths[1]}px 5px 1fr` }}>
        <nav className="col side" aria-label="项目列表">
          <div className="label">仓库</div>
          <div className="grow">
            {projects.map((p) => (
              <div key={p.path} className={`proj ${cur && sameDir(cur, p.path) ? 'sel' : ''}`}>
                <button className="main" onClick={() => setCur(p.path)} title={p.path}>
                  <span className="nm ellipsis">{p.name}</span><span className="pp ellipsis">{p.path}</span>
                </button>
                <button className="btn icon small ghost rm" aria-label={`从列表移除 ${p.name}`} title="从列表移除（不删除文件）" onClick={() => setModal({ kind: 'remove', project: p })}><X size={14} /></button>
              </div>
            ))}
            {projects.length === 0 && <p className="muted" style={{ padding: '4px 8px' }}>还没有项目</p>}
          </div>
          <button className="btn" onClick={chooseFolder} title="选择电脑上的一个文件夹，开始管理它的版本"><FolderPlus size={15} />添加文件夹</button>
          <button className="btn" onClick={() => setCloneOpen(true)} title="把网上已有的仓库完整下载到电脑"><Link2 size={15} />从网址克隆</button>
        </nav>
        <div className="split-h" role="separator" tabIndex={0} aria-label="调整项目栏宽度" onPointerDown={drag(0)} onKeyDown={nudge(0)} />

        <section className="col mid" aria-label={view === 'changes' ? '文件列表' : '历史版本'}>
          {isRepo ? (
            <>
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={view === 'changes'} className={`tab ${view === 'changes' ? 'on' : ''}`} onClick={() => setView('changes')}>修改{files.length ? ` ${files.length}` : ''}</button>
                <button role="tab" aria-selected={view === 'history'} className={`tab ${view === 'history' ? 'on' : ''}`} onClick={() => setView('history')}>历史版本</button>
                <button role="tab" aria-selected={view === 'branches'} className={`tab ${view === 'branches' ? 'on' : ''}`} onClick={() => setView('branches')}>分支</button>
                <button role="tab" aria-selected={view === 'stash'} className={`tab ${view === 'stash' ? 'on' : ''}`} onClick={() => setView('stash')}>暂存修改</button>
              </div>
              {view === 'changes' ? (
                <>
                  <Explain id="changes" title="怎么保存一个版本？">这里列出你改过的文件。<b>勾选文件</b>＝挑进下一个版本；写一句说明，点「保存版本」，就像给文件拍一张存档快照，以后随时能回到这一刻。保存只发生在你的电脑里，不会上传。</Explain>
                  {loading && !snap ? <div className="list"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
                    : items.length ? <VirtualList items={items} rowHeight={34} render={renderItem} />
                    : <div className="list"><p className="muted" style={{ padding: 16 }}>{snap?.head ? '没有需要保存的修改。' : '还没有文件。'}</p></div>}
                  <div className="commitbox">
                    <textarea value={message} placeholder="写下这次修改的缘由，例如：完成第一章初稿" aria-label="版本说明" maxLength={2000}
                      onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.ctrlKey && e.key === 'Enter' && canCommit) doCommit(); }} />
                    {snap?.head && <label className="check" title={amendOk ? '刚保存完发现漏了文件或说明写错了？勾选后可补救（不产生新版本）' : '上一次保存已经上传到远程，修改它会造成分叉，所以不能修改'}><input type="checkbox" checked={amend} disabled={!amendOk || !!busy} onChange={(e) => toggleAmend(e.target.checked)} />修改上一次保存{!amendOk && <span className="faint">（已上传，不可改）</span>}</label>}
                    <button className="btn primary" disabled={!canCommit} onClick={doCommit}>
                      {busy?.startsWith('正在保存版本') || busy?.startsWith('正在更新') ? <Loader2 size={15} className="spin" /> : <Save size={15} />}{amend ? '更新上一次保存' : '保存版本'}{!amend && stagedFiles.length ? `（${stagedFiles.length} 个文件）` : ''}
                    </button>
                    <span className="faint" style={{ fontSize: 11.5 }}>
                      {conflicts.length ? '请先处理冲突文件。' : amend ? '勾选要补进上一次保存的文件（可不选），并可修改说明。' : !stagedFiles.length ? '勾选上方文件，把它们“准备保存”。' : '只保存在本机（Commit），不会上传。Ctrl+Enter 快速保存。'}
                    </span>
                  </div>
                </>
              ) : view === 'branches' ? branchesPane.list : view === 'stash' ? stashPane.list : (
                <>
                  <Explain id="history" title="历史版本是什么？">每次「保存版本」都会在这里留下一条记录。点开一条，可以看当时改了什么；发现保存错了，可以「撤销这次保存」，历史不会被改写。</Explain>
                  <div className="searchbar"><Search size={14} className="faint" /><input type="text" aria-label="搜索历史版本" placeholder={histMode === 'author' ? '按作者搜索…' : '按说明搜索…'} value={histQ} onChange={(e) => setHistQ(e.target.value)} />
                    <div className="seg"><button className={histMode === 'message' ? 'on' : ''} onClick={() => setHistMode('message')}>说明</button><button className={histMode === 'author' ? 'on' : ''} onClick={() => setHistMode('author')}>作者</button></div></div>
                  {histFile && <div className="sect"><span className="chip" style={{ maxWidth: '100%' }}><span className="ellipsis">仅 {histFile}</span><button className="btn icon small ghost" style={{ width: 18, height: 18 }} aria-label="清除文件筛选" onClick={() => setHistFile('')}><X size={12} /></button></span></div>}
                  {commits.length === 0 && !more ? <div className="list"><p className="muted" style={{ padding: 16 }}>{snap?.head ? '没有找到版本。' : '还没有保存过版本。保存第一个版本后，这里会出现历史记录。'}</p></div>
                    : <VirtualList items={commits} rowHeight={58} render={(c) => (
                      <div key={c.sha} className={`row hrow ${histSel?.sha === c.sha ? 'sel' : ''}`} role="option" aria-selected={histSel?.sha === c.sha} tabIndex={0} onClick={() => setHistSel(c)} onKeyDown={(e) => { if (e.key === 'Enter') setHistSel(c); }}>
                        <span className="s ellipsis">{c.subject || '（无说明）'}{c.refs && refChips(c.refs)}</span>
                        <span className="m"><span>{fmtDate(c.date)}</span><span className="ellipsis">{c.author}</span><span className="mono faint">{c.sha.slice(0, 7)}</span></span>
                      </div>)} />}
                  {more && <div className="commitbox" style={{ padding: 8 }}><button className="btn" onClick={() => loadHistory(false)}>加载更多</button></div>}
                </>
              )}
            </>
          ) : <div className="list" />}
        </section>
        <div className="split-h" role="separator" tabIndex={0} aria-label="调整文件栏宽度" onPointerDown={drag(1)} onKeyDown={nudge(1)} />

        <main className="col main">
          {!cur ? (
            <Center icon={<FolderGit2 size={44} />} title="为文件夹保存每一个版本">
              <p>选择一个文件夹，就能记录它的每次改动，随时回看或撤销。全程在本机完成，无需账号和网络。</p>
              <button className="btn primary" onClick={chooseFolder}><FolderPlus size={15} />选择文件夹</button>
              <ol className="steps"><li><b>选择文件夹</b><span>任何放着你文档、代码的文件夹</span></li><li><b>勾选并写一句说明</b><span>告诉未来的自己这次改了什么</span></li><li><b>保存版本</b><span>随时回看、撤销，不怕改坏</span></li></ol>
              <div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={() => setCloneOpen(true)}><Link2 size={15} />从网址克隆</button><button className="btn ghost" onClick={() => setHelpOpen(true)}><HelpCircle size={15} />使用帮助</button></div>
            </Center>
          ) : projErr ? (
            <Center icon={<FolderX size={44} />} tone="err" title="无法打开这个文件夹"><p>{projErr}</p>
              <div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={() => loadProject(cur)}><RefreshCw size={15} />重试</button>{project && <button className="btn danger" onClick={() => setModal({ kind: 'remove', project })}>从列表移除</button>}</div>
            </Center>
          ) : loading && !info ? (
            <Center icon={<Loader2 size={44} className="spin" />} title="正在读取…" />
          ) : info && !info.repository ? (
            <Center icon={<FolderGit2 size={44} />} title="这个文件夹还没有版本记录">
              <p>创建仓库后，就可以保存版本。这只会在文件夹中新增一个隐藏的 .git 文件夹，不会改动你的文件，也不会上传任何内容。</p>
              <div className="pathbox">{info.path}</div>
              {info.error && <p style={{ color: 'var(--removed-ink)' }}>{firstLine(info.error)}</p>}
              <button className="btn primary" disabled={!!busy} onClick={createRepo}>{busy ? <Loader2 size={15} className="spin" /> : <FolderGit2 size={15} />}在此创建仓库</button>
            </Center>
          ) : info && !isRepo ? (
            <Center icon={<GitFork size={44} />} title="这个文件夹位于另一个仓库里">
              <p>为避免创建嵌套仓库，纸笺不会在这里新建。你可以打开包含它的上级仓库：</p>
              <div className="pathbox">{info.repository}</div>
              <button className="btn primary" onClick={() => { const repo = info.repository; const me = project; if (me) persist(projects.filter((p) => p.path !== me.path)); openPath(repo); }}>打开上级仓库</button>
            </Center>
          ) : (
            <>
              {snap?.operation && (
                <div className="banner warn"><AlertTriangle size={15} />
                  <span>有一个未完成的“{({ merge: '合并', rebase: '变基', revert: '撤销', 'cherry-pick': '摘取' } as Record<string, string>)[snap.operation] ?? snap.operation}”操作。解决冲突后可用其他 Git 工具继续，或在此中止，回到操作前的状态。</span><span className="sp" />
                  <button className="btn small" disabled={!!busy || conflicts.length > 0} title={conflicts.length ? '请先解决全部冲突' : ''} onClick={() => run('正在继续…', async () => { await git('operation', cur, { action: 'continue' }); await refresh(false); flash({ kind: 'ok', text: '操作已完成。' }); })}>继续</button>
                  <button className="btn small danger" onClick={() => run('正在中止…', async () => { await git('operation', cur, { action: 'abort' }); await refresh(false); })}>中止操作</button>
                </div>)}
              {!snap?.operation && conflicts.length > 0 && <div className="banner err"><AlertTriangle size={15} />有 {conflicts.length} 个文件存在冲突，请打开文件手动处理，再回来刷新。</div>}
              {view === 'branches' ? branchesPane.detail : view === 'stash' ? stashPane.detail : <>
              {view === 'changes' ? (
                <div className="pane-head">
                  <h2 className="ellipsis">{sel ? sel.path : '修改'}</h2>
                  {target && diff && !diff.binary && <div className="seg" role="group" aria-label="差异视图"><button className={diffMode === 'unified' ? 'on' : ''} onClick={() => setDiffMode('unified')}>统一</button><button className={diffMode === 'split' ? 'on' : ''} onClick={() => setDiffMode('split')}>左右对照</button></div>}
                  {sel && selFile && selFile.index !== '?' && !selFile.conflict && <button className="btn small ghost" title="逐行查看：每一行是谁、在哪次保存里改的" onClick={() => setBlameTarget({ file: sel.path, sha: '' })}><FileSearch size={14} />逐行追溯</button>}
                  {sel && <button className="btn small ghost" title="查看此文件的历史版本" onClick={() => { setHistFile(sel.path); setView('history'); }}><History size={14} />文件历史</button>}
                  {sel?.group === 'conflict' && <><button className="btn small" disabled={!!busy} title={snap?.operation === 'rebase' ? '注意：变基期间“我的”与“对方的”含义相反' : '整个文件保留你这边的内容'} onClick={() => resolve('ours')}>保留我的</button><button className="btn small" disabled={!!busy} title="整个文件采用对方的内容" onClick={() => resolve('theirs')}>采用对方的</button><button className="btn small" onClick={() => openFile(sel.path)}><ExternalLink size={14} />手动编辑</button><button className="btn small primary" disabled={!!busy} title="手动改好后，点这里告诉 Git 已处理完" onClick={() => stage([sel.path], true)}><Check size={14} />标记为已解决</button></>}
                  {canDiscard && <button className="btn small danger" disabled={!!busy} onClick={() => askDiscard(selFile!)}><Undo2 size={14} />放弃修改</button>}
                </div>
              ) : histSel ? (
                <>
                  <div className="pane-head" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <h2>{histSel.subject || '（无说明）'}</h2>
                      <div className="muted" style={{ fontSize: 12 }}>{histSel.author} · {fmtDate(histSel.date)} · <span className="mono">{histSel.sha.slice(0, 7)}</span></div>
                      {histSel.body && <p className="muted" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{histSel.body}</p>}
                    </div>
                    <button className="btn small danger" disabled={!!busy || histSel.parents.split(' ').filter(Boolean).length > 1}
                      title={histSel.parents.split(' ').filter(Boolean).length > 1 ? '这是合并版本，需要指定主线才能撤销，本应用不处理' : '新增一个版本来抵消这次改动'}
                      onClick={() => setModal({ kind: 'revert', commit: histSel })}><Undo2 size={14} />撤销这次保存</button>
                  </div>
                  <div className="hactions">
                    <button className="btn small" disabled={!!busy} title="把当前分支退回到这个版本（可选择保留修改）" onClick={() => setResetTarget({ sha: histSel.sha, subject: histSel.subject })}><RotateCcw size={14} />回到此版本…</button>
                    <button className="btn small" disabled={!!busy || histSel.parents.split(' ').filter(Boolean).length > 1} title="把这一次保存单独挑过来，放进当前分支" onClick={() => run('正在复制…', async () => { try { await git('cherryPick', cur!, { sha: histSel.sha }); flash({ kind: 'ok', text: '已把这次保存复制到当前分支。' }); await refresh(true); } catch (e) { await refresh(true); if (String((e as Error).message).includes('冲突')) setView('changes'); throw e; } })}><Copy size={14} />复制到当前分支</button>
                    <button className="btn small" title="给这个版本贴一个永久的名字" onClick={() => setTagTarget(histSel.sha)}><TagIcon size={14} />贴标签</button>
                    {histSel.sha === snap?.head && amendOk && <button className="btn small" disabled={!!busy} title="撤销刚才的保存，但保留文件里的修改" onClick={() => setModal({ kind: 'undoLast' })}><Undo2 size={14} />撤销上次保存（保留修改）</button>}
                    {histFileSel && !histFileSel.status.startsWith('D') && <button className="btn small" title="逐行查看：这个文件的每一行是谁改的" onClick={() => setBlameTarget({ file: histFileSel.path, sha: histSel.sha })}><FileSearch size={14} />逐行追溯</button>}
                  </div>
                  <div style={{ maxHeight: 132, overflow: 'auto', borderBottom: '1px solid var(--rule)' }}>
                    {histFiles.map((f) => (
                      <div key={f.path} className={`row ${histFileSel?.path === f.path ? 'sel' : ''}`} style={{ height: 30 }} tabIndex={0} onClick={() => setHistFileSel(f)} onKeyDown={(e) => { if (e.key === 'Enter') setHistFileSel(f); }}>
                        <Badge code={f.status[0]} /><span className="fname ellipsis">{f.path}</span>
                      </div>))}
                  </div>
                  <div className="pane-head" style={{ minHeight: 40 }}>
                    <span style={{ flex: 1 }} />
                    {diff && !diff.binary && <div className="seg"><button className={diffMode === 'unified' ? 'on' : ''} onClick={() => setDiffMode('unified')}>统一</button><button className={diffMode === 'split' ? 'on' : ''} onClick={() => setDiffMode('split')}>左右对照</button></div>}
                  </div>
                </>
              ) : null}
              {renderDetail()}</>}
            </>
          )}
        </main>
      </div>

      <footer className="foot" role="status" aria-live="polite">
        {busy ? <><span className="bar" /><span className="msg">{busy}</span><button className="btn small ghost" title="停止正在进行的 Git 操作" onClick={() => cancelTasks()}>取消</button></>
          : msg ? <span className={`msg ellipsis ${msg.kind}`}>{msg.text}{msg.action && <> <button className="btn small ghost" onClick={msg.action.run}>{msg.action.label}</button></>}</span>
          : <span className="msg">{isRepo ? '就绪' : '选择或添加一个文件夹开始'}</span>}
        <span className="faint">{env.git.replace(/^git version /, 'Git ')}</span>
      </footer>

      {palette && (
        <Palette onClose={() => setPalette(false)} commands={[
          ...(cur ? [{ id: 'refresh', label: '刷新', run: () => run('正在刷新…', () => refresh(false)) }] : []),
          ...(isRepo ? [
            { id: 'v-changes', label: '转到：修改', run: () => setView('changes') },
            { id: 'v-history', label: '转到：历史版本', run: () => setView('history') },
            { id: 'v-branches', label: '转到：分支与标签', run: () => setView('branches') },
            { id: 'v-stash', label: '转到：暂存修改', run: () => setView('stash') },
            { id: 'reflog', label: '操作记录（后悔药）…', hint: '找回误操作前的状态', run: () => setReflogOpen(true) },
            { id: 'd-unified', label: '差异：统一视图', run: () => setDiffMode('unified') },
            { id: 'd-split', label: '差异：左右对照', run: () => setDiffMode('split') },
            ...(canCommit ? [{ id: 'commit', label: '保存版本', hint: `${stagedFiles.length} 个文件`, run: doCommit }] : []),
          ] : []),
          { id: 'add', label: '添加文件夹…', run: chooseFolder },
          { id: 'clone', label: '从网址克隆仓库…', run: () => setCloneOpen(true) },
          { id: 'help', label: '使用帮助', hint: '场景与名词解释', run: () => setHelpOpen(true) },
          { id: 'theme', label: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题', run: () => setTheme(theme === 'dark' ? 'light' : 'dark') },
          ...projects.map((p) => ({ id: `p:${p.path}`, label: `切换到：${p.name}`, hint: p.path, run: () => setCur(p.path) })),
        ]} />
      )}
      {branchesPane.overlay}{stashPane.overlay}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} onReset={() => { resetHints(); flash({ kind: 'ok', text: '提示卡会在下次切换页面时重新出现。' }); setHelpOpen(false); setView('changes'); setRev((r) => r + 1); }} />}
      {cloneOpen && <CloneModal onClose={() => setCloneOpen(false)} onCloned={(p) => openPath(p)} run={run} flash={flash} />}
      {reflogOpen && <ReflogModal ctx={ctx} onClose={() => setReflogOpen(false)} onPick={(e) => { setReflogOpen(false); setResetTarget({ sha: e.sha, subject: e.subject }); }} />}
      {resetTarget && <ResetModal ctx={ctx} target={resetTarget} onClose={() => setResetTarget(null)} />}
      {tagTarget && <TagModal ctx={ctx} sha={tagTarget} onClose={() => setTagTarget(null)} onDone={() => loadHistory(true)} />}
      {blameTarget && <BlameModal ctx={ctx} file={blameTarget.file} sha={blameTarget.sha} onClose={() => setBlameTarget(null)} />}
      {modal?.kind === 'undoLast' && (
        <Modal title="撤销上次保存（保留修改）？" onClose={() => setModal(null)} actions={<>
          <button className="btn" onClick={() => setModal(null)}>取消</button>
          <button className="btn primary" onClick={() => { setModal(null); run('正在撤销…', async () => { await git('resetLastSoft', cur!); await refresh(false); flash({ kind: 'ok', text: '已撤销上次保存，文件里的修改都还在，并处于“已准备保存”。' }); }); }}>撤销并保留修改</button></>}>
          <p>最近这次保存会被撤销，但<b>文件里的内容原样保留</b>，并回到“已准备保存”状态，你可以重新选择、重新写说明。</p>
          <p className="muted">只适合还没上传到远程的保存。</p>
        </Modal>)}
      {modal?.kind === 'identity' && <IdentityModal onClose={() => setModal(null)} onSave={(n, e) => saveIdentity(n, e, modal.commitAfter)} />}
      {modal?.kind === 'discard' && (
        <Modal title="放弃这个文件的修改？" onClose={() => setModal(null)} actions={<>
          <button className="btn" onClick={() => setModal(null)}>取消</button>
          <button className="btn danger solid" onClick={() => { const m = modal; setModal(null); run('正在放弃修改…', async () => { await git('discard', cur!, { file: m.file.path, token: m.token }); await refresh(false); flash({ kind: 'ok', text: '已放弃修改，文件恢复为最近保存的版本。' }); }); }}>放弃修改</button></>}>
          <p><b className="mono">{modal.file.path}</b> 中尚未保存的修改将<b style={{ color: 'var(--removed-ink)' }}>永久丢失，无法恢复</b>{modal.added + modal.removed > 0 ? `（约 +${modal.added} −${modal.removed} 行）` : ''}。</p>
          <p className="muted">文件会回到最近一次保存的样子。其他文件和历史版本不受影响。{modal.file.index !== ' ' ? '已准备保存的部分会保留。' : ''}</p>
        </Modal>)}
      {modal?.kind === 'revert' && (
        <Modal title="撤销这次保存？" onClose={() => setModal(null)} actions={<>
          <button className="btn" onClick={() => setModal(null)}>取消</button>
          <button className="btn primary" onClick={() => { const c = modal.commit; setModal(null); run('正在撤销…', async () => { await git('revert', cur!, { sha: c.sha }); await refresh(false); await loadHistory(true); flash({ kind: 'ok', text: '已新增一个“撤销”版本，原历史保持不变。' }); }); }}>新增撤销版本</button></>}>
          <p>将新增一个版本，抵消「{modal.commit.subject}」带来的改动。原来的历史记录不会被删除或改写。</p>
          <p className="muted">需要当前没有未保存的修改；如果与后来的改动冲突，会停下来等你处理。</p>
        </Modal>)}
      {modal?.kind === 'remove' && (
        <Modal title="从列表移除项目？" onClose={() => setModal(null)} actions={<>
          <button className="btn" onClick={() => setModal(null)}>取消</button><button className="btn primary" onClick={() => removeProject(modal.project)}>移除</button></>}>
          <p>只会从纸笺 Git 的列表中移除「{modal.project.name}」，<b>不会删除文件夹、文件或版本记录</b>。</p>
        </Modal>)}
      {modal?.kind === 'error' && (
        <Modal title="操作详情" onClose={() => setModal(null)} actions={<button className="btn primary" onClick={() => setModal(null)}>知道了</button>}>
          <pre className="mono" style={{ margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--paper-deep)', padding: 10, borderRadius: 8 }}>{modal.text}</pre>
        </Modal>)}
    </div>
  );
}

function WinCtl() {
  return (
    <div className="winctl">
      <button aria-label="最小化" onClick={() => getCurrentWindow().minimize()}><Minus size={16} /></button>
      <button aria-label="最大化或还原" onClick={() => getCurrentWindow().toggleMaximize()}><Square size={12} /></button>
      <button className="close" aria-label="关闭" onClick={() => getCurrentWindow().close()}><X size={16} /></button>
    </div>
  );
}

/** 启动中、缺少 Git 等尚无主界面的状态：仍提供可拖动的标题栏和窗口按钮。 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="titlebar" data-tauri-drag-region><div className="brand" data-tauri-drag-region><Logo />纸笺 Git</div><div className="tb-repo" data-tauri-drag-region /><WinCtl /></header>
      <div />
      <div className="col main">{children}</div><div />
    </div>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" strokeLinejoin="round" strokeLinecap="round">
      <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="var(--paper-card)" stroke="var(--ink)" strokeWidth="1.5" />
      <path d="M14 3v4a1 1 0 0 0 1 1h4" stroke="var(--ink)" strokeWidth="1.5" />
      <path d="M9.5 11.5v5" stroke="var(--clay)" strokeWidth="1.6" /><circle cx="9.5" cy="11.5" r="1.4" fill="var(--paper-card)" stroke="var(--clay)" strokeWidth="1.4" /><circle cx="9.5" cy="16.5" r="1.4" fill="var(--clay)" />
    </svg>
  );
}

type Cmd = { id: string; label: string; hint?: string; run: () => void };
function Palette({ commands, onClose }: { commands: Cmd[]; onClose: () => void }) {
  const [q, setQ] = useState(''); const [i, setI] = useState(0);
  const list = commands.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  useEffect(() => setI(0), [q]);
  const go = (c?: Cmd) => { if (c) { onClose(); c.run(); } };
  return (
    <div className="scrim top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <input autoFocus type="text" placeholder="输入命令或项目名…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索命令"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => Math.min(list.length - 1, n + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => Math.max(0, n - 1)); }
            else if (e.key === 'Enter') go(list[i]);
          }} />
        <div className="items" role="listbox">
          {list.map((c, n) => (
            <button key={c.id} role="option" aria-selected={n === i} className={`pitem ${n === i ? 'on' : ''}`} onMouseEnter={() => setI(n)} onClick={() => go(c)}>
              <span>{c.label}</span><span className="sp" />{c.hint && <span className="faint">{c.hint}</span>}
            </button>
          ))}
          {list.length === 0 && <p className="faint" style={{ padding: 10, margin: 0 }}>没有匹配的命令</p>}
        </div>
      </div>
    </div>
  );
}

function IdentityModal({ onSave, onClose }: { onSave: (name: string, email: string) => void; onClose: () => void }) {
  const [name, setName] = useState(''); const [email, setEmail] = useState('');
  const ok = name.trim() && /.+@.+/.test(email.trim());
  return (
    <Modal title="署名后才能保存版本" onClose={onClose} actions={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={!ok} onClick={() => onSave(name.trim(), email.trim())}>保存并继续</button></>}>
      <p className="muted">每个版本都会记录是谁保存的。这里的设置只保存在<b>当前仓库</b>，不会修改电脑上的全局 Git 配置；邮箱不必真实。</p>
      <div className="field"><label htmlFor="gn">姓名</label><input id="gn" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：小明" /></div>
      <div className="field"><label htmlFor="ge">邮箱</label><input id="ge" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="例如：me@example.com" onKeyDown={(e) => { if (e.key === 'Enter' && ok) onSave(name.trim(), email.trim()); }} /></div>
    </Modal>
  );
}
