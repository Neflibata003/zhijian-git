import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/** 定高行虚拟列表；条目不多时直接全量渲染。 */
export function VirtualList<T>({ items, rowHeight, render, threshold = 150 }: {
  items: T[]; rowHeight: number; render: (item: T, index: number) => ReactNode; threshold?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    setHeight(el.clientHeight);
    const ob = new ResizeObserver(() => setHeight(el.clientHeight));
    ob.observe(el);
    return () => ob.disconnect();
  }, []);
  const virtual = items.length > threshold;
  const start = virtual ? Math.max(0, Math.floor(top / rowHeight) - 6) : 0;
  const end = virtual ? Math.min(items.length, Math.ceil((top + height) / rowHeight) + 6) : items.length;
  return (
    <div className="list" ref={ref} onScroll={virtual ? (e) => setTop(e.currentTarget.scrollTop) : undefined}>
      {virtual ? (
        <div style={{ height: items.length * rowHeight, position: 'relative' }}>
          <div style={{ position: 'absolute', top: start * rowHeight, left: 0, right: 0 }}>
            {items.slice(start, end).map((it, i) => render(it, start + i))}
          </div>
        </div>
      ) : items.map((it, i) => render(it, i))}
    </div>
  );
}

export function Modal({ title, children, actions, onClose }: { title: string; children: ReactNode; actions: ReactNode; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('input,textarea,button.primary,button.solid')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={box}>
        <h3>{title}</h3>{children}<div className="acts">{actions}</div>
      </div>
    </div>
  );
}

interface Line { kind: 'hunk' | 'add' | 'del' | 'ctx'; a?: number; b?: number; text: string; hunk?: number }

export function parseDiff(text: string): Line[] {
  const out: Line[] = []; let a = 0, b = 0, started = false, h = -1;
  for (const raw of text.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) { started = true; a = +m[1]; b = +m[2]; h++; out.push({ kind: 'hunk', text: raw, hunk: h }); continue; }
    if (!started) continue;
    if (raw.startsWith('+')) out.push({ kind: 'add', b: b++, text: raw.slice(1) });
    else if (raw.startsWith('-')) out.push({ kind: 'del', a: a++, text: raw.slice(1) });
    else if (raw.startsWith('\\')) out.push({ kind: 'ctx', text: raw });
    else if (raw !== '' || out.length) out.push({ kind: 'ctx', a: a++, b: b++, text: raw.slice(1) });
  }
  while (out.length && out[out.length - 1].kind === 'ctx' && out[out.length - 1].text === '') out.pop();
  return out;
}

const LIMIT = 3000;

export interface HunkAction { label: string; title: string; run: (index: number) => void; disabled?: boolean }

export function DiffView({ text, mode, hunkAction }: { text: string; mode: 'unified' | 'split'; hunkAction?: HunkAction }) {
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [text]);
  const lines = useMemo(() => parseDiff(text), [text]);
  const shown = more ? lines : lines.slice(0, LIMIT);
  const pairs = useMemo(() => {
    if (mode !== 'split') return [];
    const rows: [Line | null, Line | null][] = [];
    for (let i = 0; i < shown.length;) {
      const l = shown[i];
      if (l.kind === 'del') {
        const dels: Line[] = [], adds: Line[] = [];
        while (i < shown.length && shown[i].kind === 'del') dels.push(shown[i++]);
        while (i < shown.length && shown[i].kind === 'add') adds.push(shown[i++]);
        for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push([dels[k] ?? null, adds[k] ?? null]);
      } else if (l.kind === 'add') { rows.push([null, l]); i++; }
      else { rows.push([l, l]); i++; }
    }
    return rows;
  }, [shown, mode]);

  const hunkBtn = (l: Line) => hunkAction && l.hunk !== undefined ? <button className="btn small hunkbtn" title={hunkAction.title} disabled={hunkAction.disabled} onClick={() => hunkAction.run(l.hunk!)}>{hunkAction.label}</button> : null;
  const cell = (l: Line | null, side: 'a' | 'b', i: number) => l
    ? <div className={`dl ${l.kind === 'hunk' ? 'hunk' : l.kind === 'ctx' ? '' : l.kind}`} key={i}><span className="n">{l[side] ?? ''}</span><span className="t">{l.text}{side === 'a' && l.kind === 'hunk' ? hunkBtn(l) : null}</span></div>
    : <div className="dl" key={i}><span className="n" /><span className="t"> </span></div>;

  return (
    <div className="diff" tabIndex={0} aria-label="差异预览">
      {mode === 'unified'
        ? shown.map((l, i) => (
          <div className={`dl ${l.kind === 'ctx' ? '' : l.kind}`} key={i}>
            <span className="n">{l.a ?? ''}</span><span className="n">{l.b ?? ''}</span><span className="t">{l.kind === 'hunk' ? <>{l.text}{hunkBtn(l)}</> : (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text}</span>
          </div>))
        : <div className="split">
          <div>{pairs.map(([l], i) => cell(l, 'a', i))}</div>
          <div>{pairs.map(([, r], i) => cell(r, 'b', i))}</div>
        </div>}
      {!more && lines.length > LIMIT && (
        <div style={{ padding: 12 }}><button className="btn small" onClick={() => setMore(true)}>已显示前 {LIMIT} 行，共 {lines.length} 行，继续显示全部</button></div>
      )}
      {lines.length === 0 && <div style={{ padding: 16, color: 'var(--muted)' }}>没有可显示的文本变化（可能只是权限或换行符变化）。</div>}
    </div>
  );
}
