import { invoke } from '@tauri-apps/api/core';

export interface FileEntry { path: string; old: string | null; index: string; worktree: string; conflict: boolean }
export interface Snapshot {
  files: FileEntry[]; branch: string; head: string; detached: boolean; orphan: number; operation: string;
  upstream: string; ahead: number; behind: number; remotes: string[];
  name: string; email: string;
}
export interface Inspect { path: string; repository: string; error: string }
export interface Commit { sha: string; parents: string; author: string; date: string; subject: string; body: string; refs: string }
export interface NameStatus { status: string; path: string; old?: string }
export interface DiffResult { text: string; binary: boolean; limited: boolean; size: number }
export interface Project { path: string; name: string }
export interface Staged { token: string; files: NameStatus[] }
export interface Branch { name: string; current: boolean; sha: string; subject: string; upstream: string; track: string }
export interface Stash { id: string; sha: string; subject: string; date: string }
export interface Remote { name: string; url: string }
export interface Tag { name: string; sha: string; subject: string; date: string }
export interface ReflogEntry { sha: string; ref: string; subject: string; date: string }
export interface BlameRow { sha: string; author: string; time: string; summary: string; text: string }
export interface Blame { rows: BlameRow[]; total: number; limited: boolean }

export const git = <T = unknown>(op: string, path?: string, args?: Record<string, unknown>) =>
  invoke<T>('request', { op, path: path ?? null, args: args ?? {} }).catch((e) => { throw new Error(String(e)); });

export const watchProject = (path: string | null) => invoke('watch_project', { path });
export const cancelTasks = () => invoke('cancel_task');
export const initialPath = () => invoke<string | null>('initial_path');

/** 规范化路径以便比较：统一斜杠、去掉尾部斜杠、忽略大小写（Windows）。 */
const slashes = (p: string) => p.split('\\').join('/').replace(/\/+$/, '');
export const norm = (p: string) => slashes(p).toLowerCase();
export const baseName = (p: string) => slashes(p).split('/').pop() || p;
