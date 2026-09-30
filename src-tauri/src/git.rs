use serde_json::{json, Value};
use std::{collections::hash_map::DefaultHasher, hash::{Hash, Hasher}, io::Read, path::{Component, Path, PathBuf}, process::{Command, Stdio}, sync::{atomic::{AtomicU64, Ordering}, Arc}, time::{Duration, Instant}};
use tauri::Manager;
#[cfg(windows)] use std::os::windows::process::CommandExt;

const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
struct Output { ok: bool, bytes: Vec<u8>, error: String }
pub struct Git<'a> { root: &'a Path, cancel: &'a Arc<AtomicU64>, generation: u64 }
impl Git<'_> {
    fn run(&self, args: &[&str]) -> Result<Output, String> { self.run_with(args, None, 180) }
    fn run_with(&self, args: &[&str], input: Option<&[u8]>, timeout: u64) -> Result<Output, String> {
        if self.cancel.load(Ordering::Relaxed) != self.generation { return Err("任务已取消".into()); }
        let mut cmd = Command::new("git");
        // stash --include-untracked 与 --literal-pathspecs 同用时会悄悄漏掉未跟踪文件，所以暂存类命令不加它。
        if args.first() != Some(&"stash") { cmd.arg("--literal-pathspecs"); }
        cmd.args(["-c", "core.quotepath=false", "-C"]).arg(self.root).args(args)
            .env("GIT_TERMINAL_PROMPT", "0").env("GCM_INTERACTIVE", "auto").stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)] cmd.creation_flags(0x08000000);
        let mut child = cmd.spawn().map_err(|e| format!("无法启动 Git。请安装 Git for Windows 并重新打开应用。{e}"))?;
        let out = child.stdout.take().unwrap(); let err = child.stderr.take().unwrap();
        if let (Some(data), Some(mut stdin)) = (input, child.stdin.take()) { let data = data.to_vec(); std::thread::spawn(move || { use std::io::Write; let _ = stdin.write_all(&data); }); }
        let read = |mut stream: Box<dyn Read + Send>| { let mut buf = Vec::new(); let mut chunk = [0u8; 8192]; let mut exceeded = false;
            loop { match stream.read(&mut chunk) { Ok(0) | Err(_) => break, Ok(n) => { if buf.len() + n <= OUTPUT_LIMIT { buf.extend_from_slice(&chunk[..n]); } else { exceeded = true; } } } } (buf, exceeded) };
        let a = std::thread::spawn(move || read(Box::new(out))); let b = std::thread::spawn(move || read(Box::new(err)));
        let start = Instant::now(); let mut abort = None;
        let status = loop {
            if self.cancel.load(Ordering::Relaxed) != self.generation { abort = Some("任务已取消；操作可能已完成，请刷新确认仓库状态。"); }
            if start.elapsed() > Duration::from_secs(timeout) { abort = Some("Git 操作超时，已停止。请刷新后确认状态。"); }
            if abort.is_some() { let _ = child.kill(); let _ = child.wait(); break None; }
            match child.try_wait() { Ok(Some(s)) => break Some(s), Ok(None) => std::thread::sleep(Duration::from_millis(25)), Err(e) => { let _ = child.kill(); return Err(e.to_string()); } }
        };
        let (bytes, too_large) = a.join().map_err(|_| "读取 Git 输出失败")?;
        let (error, _) = b.join().map_err(|_| "读取 Git 错误失败")?;
        if let Some(reason) = abort { return Err(reason.into()); }
        if too_large { return Err("Git 输出超过 16MB。请缩小查询范围或使用 Git 工具处理超大仓库。".into()); }
        Ok(Output { ok: status.unwrap().success(), bytes, error: String::from_utf8_lossy(&error).chars().take(8000).collect() })
    }
    fn run_with_ok(&self, args: &[&str], timeout: u64) -> Result<(), String> { let o = self.run_with(args, None, timeout)?; if o.ok { Ok(()) } else { Err(classify(&failure_text(&o))) } }
    fn bytes(&self, args: &[&str]) -> Result<Vec<u8>, String> { let o = self.run(args)?; if o.ok { Ok(o.bytes) } else { Err(classify(&failure_text(&o))) } }
    fn text(&self, args: &[&str]) -> Result<String, String> { Ok(String::from_utf8_lossy(&self.bytes(args)?).trim_end().to_string()) }
    fn optional(&self, args: &[&str]) -> String { self.text(args).unwrap_or_default() }
    fn clean(&self) -> Result<(), String> { if !self.bytes(&["status", "--porcelain=v1", "-z"])?.is_empty() { Err("请先保存版本或暂存修改，使工作区与暂存区保持干净，再进行此操作。".into()) } else { Ok(()) } }
    fn revision(&self, value: &str) -> Result<String, String> {
        if value.starts_with('-') || value.len() > 200 { return Err("无效版本标识".into()); }
        self.text(&["rev-parse", "--verify", &format!("{value}^{{commit}}")])
    }
}
/// 失败信息 = 标准错误 + 标准输出的开头（merge/cherry-pick 的 CONFLICT 提示写在标准输出里）。
fn failure_text(o: &Output) -> String {
    let out = String::from_utf8_lossy(&o.bytes[..o.bytes.len().min(4000)]);
    if out.trim().is_empty() { o.error.clone() } else { format!("{}
{}", o.error, out) }
}
fn classify(s: &str) -> String {
    let prefix = if s.contains("Authentication failed") || s.contains("Permission denied") || s.contains("could not read Username") { "远程身份验证失败。请检查 Git 凭据管理器与访问权限。" }
        else if s.contains("Could not resolve") || s.contains("Failed to connect") || s.contains("unable to access") { "网络连接失败。请检查网络与远程地址。" }
        else if s.contains("non-fast-forward") || s.contains("[rejected]") { "远程拒绝上传：远程可能有新版本，请先获取并合并更新。不会自动强制推送。" }
        else if s.contains("CONFLICT") || s.contains("conflict") { "存在冲突。请解决文件中的冲突后刷新；可在操作状态中继续或中止。" }
        else if s.contains("index.lock") { "仓库被其他 Git 操作占用。请等待该操作结束后重试。" }
        else { "Git 操作失败。" };
    format!("{prefix}\n{}", s.chars().take(8000).collect::<String>())
}
fn fields(bytes: &[u8]) -> Vec<String> { bytes.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).to_string()).collect() }
pub fn parse_status(bytes: &[u8]) -> Vec<Value> {
    let chunks = fields(bytes); let mut result = vec![]; let mut i = 0;
    while i < chunks.len() {
        let s = &chunks[i]; if s.len() < 4 { i += 1; continue; }
        let x = s.as_bytes()[0] as char; let y = s.as_bytes()[1] as char;
        let path = s[3..].to_string(); let mut old = None;
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' { i += 1; old = chunks.get(i).cloned(); }
        let conflict = x == 'U' || y == 'U' || s.starts_with("AA") || s.starts_with("DD");
        result.push(json!({"path":path,"old":old,"index":x.to_string(),"worktree":y.to_string(),"conflict":conflict})); i += 1;
    } result
}
fn file(value: &str) -> Result<&str, String> {
    if value.is_empty() || Path::new(value).components().any(|c| !matches!(c, Component::Normal(_))) || value.split(['/', '\\']).any(|p| p.eq_ignore_ascii_case(".git")) { return Err("文件路径必须位于当前仓库内".into()); } Ok(value)
}
fn safe_local(root: &Path, value: &str) -> Result<PathBuf, String> {
    file(value)?; let p = root.join(value);
    let real = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
    let base = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !real.starts_with(base) { return Err("拒绝打开指向仓库之外的链接".into()); } Ok(real)
}
fn arg<'a>(args: &'a Value, key: &str) -> &'a str { args[key].as_str().unwrap_or("") }
fn selected(args: &Value) -> Result<Vec<String>, String> { args["files"].as_array().ok_or("未选择文件")?.iter().map(|x| file(x.as_str().ok_or("无效文件名")?).map(str::to_string)).collect() }
fn fingerprint(bytes: &[u8]) -> String { let mut h = DefaultHasher::new(); bytes.hash(&mut h); format!("{:x}", h.finish()) }
fn staged(g: &Git) -> Result<Value, String> {
    // 指纹取自暂存区清单（模式、对象 ID、路径），体积很小；不要用完整 diff，含大量二进制时会超过输出上限
    let diff = g.bytes(&["ls-files", "-s", "-z"])?;
    Ok(json!({"token":fingerprint(&diff),"files":parse_names(&g.bytes(&["diff","--cached","--name-status","-z"])?)}))
}
fn parse_names(bytes: &[u8]) -> Vec<Value> {
    let f = fields(bytes); let mut out = vec![]; let mut i = 0;
    while i+1 < f.len() { let status = f[i].clone(); i+=1; let p = f[i].clone(); i+=1;
        if status.starts_with(['R','C']) && i < f.len() { out.push(json!({"status":status,"old":p,"path":f[i]})); i+=1; }
        else { out.push(json!({"status":status,"path":p})); }
    } out
}
fn snapshot(g: &Git) -> Result<Value, String> {
    let files = parse_status(&g.bytes(&["status", "--porcelain=v1", "-z", "--untracked-files=all"])?);
    let branch = g.optional(&["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let head = g.optional(&["rev-parse", "--verify", "HEAD"]);
    let upstream = g.optional(&["rev-parse", "--abbrev-ref", "@{upstream}"]);
    let counts = g.optional(&["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]); let nums: Vec<_> = counts.split_whitespace().collect();
    let gitdir = g.text(&["rev-parse","--absolute-git-dir"])?; let dir = Path::new(&gitdir);
    let operation = if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() { "rebase" } else if dir.join("MERGE_HEAD").exists() { "merge" } else if dir.join("REVERT_HEAD").exists() || dir.join("sequencer").exists() { "revert" } else if dir.join("CHERRY_PICK_HEAD").exists() { "cherry-pick" } else { "" };
    let detached = branch.is_empty() && !head.is_empty();
    let orphan = if detached { g.optional(&["rev-list", "--count", "HEAD", "--not", "--branches"]).parse::<u32>().unwrap_or(0) } else { 0 };
    let remotes = g.optional(&["remote"]).lines().map(str::to_string).collect::<Vec<_>>();
    Ok(json!({"files":files,"branch":branch,"head":head,"detached":detached,"orphan":orphan,"upstream":upstream,"ahead":nums.first().and_then(|s|s.parse::<u32>().ok()).unwrap_or(0),"behind":nums.get(1).and_then(|s|s.parse::<u32>().ok()).unwrap_or(0),"operation":operation,"remotes":remotes,"name":g.optional(&["config","user.name"]),"email":g.optional(&["config","user.email"])}))
}
fn diff(g: &Git, args: &Value) -> Result<Value,String> {
    let p = file(arg(args,"file"))?; let mode = arg(args,"mode"); let limit = if args["large"].as_bool().unwrap_or(false) {4*1024*1024} else {512*1024};
    if mode == "untracked" {
        let local = safe_local(g.root,p)?; let size = std::fs::metadata(&local).map_err(|e|e.to_string())?.len();
        let mut bytes=Vec::new(); std::fs::File::open(local).map_err(|e|e.to_string())?.take((limit+1) as u64).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
        let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
        let text = if binary {String::new()} else { let s=String::from_utf8_lossy(&bytes[..bytes.len().min(limit)]); format!("--- /dev/null\n+++ b/{p}\n@@ -0,0 +1,{} @@\n{}",s.lines().count(),s.lines().map(|l|format!("+{l}\n")).collect::<String>()) };
        return Ok(json!({"text":text,"binary":binary,"limited":size>limit as u64,"size":size}));
    }
    let mut command = vec!["diff".to_string(),"--no-ext-diff".into(),"--no-textconv".into(),"--no-color".into(),"--unified=3".into()];
    if mode == "index" {command.push("--cached".into());}
    if mode == "stash" { let sha=g.revision(arg(args,"sha"))?; command=vec!["diff".into(),"--no-ext-diff".into(),"--no-textconv".into(),"--no-color".into(),"--unified=3".into(),format!("{sha}^1"),sha]; }
    if mode == "history" { let sha=g.revision(arg(args,"sha"))?; let parents=g.text(&["rev-list","--parents","-n","1",&sha])?;
        command=vec!["show".into(),"--format=".into(),"--no-ext-diff".into(),"--no-textconv".into(),"--no-color".into(),"--first-parent".into(),"-m".into(),sha];
        if parents.split_whitespace().count()>2 {command.push("--diff-merges=first-parent".into());}
    }
    command.push("--".into()); command.push(p.into()); if let Some(old)=args["old"].as_str(){command.push(file(old)?.into());}
    let bytes=g.bytes(&command.iter().map(String::as_str).collect::<Vec<_>>())?;
    let binary=bytes.windows(12).any(|w|w==b"Binary files")||bytes.windows(16).any(|w|w==b"GIT binary patch")||std::str::from_utf8(&bytes).is_err();
    Ok(json!({"text":if binary {String::new()} else {String::from_utf8_lossy(&bytes[..bytes.len().min(limit)]).to_string()},"binary":binary,"limited":bytes.len()>limit,"size":bytes.len()}))
}
pub fn dispatch(app: &tauri::AppHandle, op: &str, path: Option<&str>, args: Value, cancel: &Arc<AtomicU64>, generation: u64) -> Result<Value,String> {
    let default=Path::new("."); let root=path.map(Path::new).unwrap_or(default); let g=Git{root,cancel,generation};
    let config_path=app.path().app_config_dir().map_err(|e|e.to_string())?.join("projects.json");
    match op {
        "environment" => { let o=g.run(&["--version"]); return Ok(json!({"git":o.as_ref().map(|x|String::from_utf8_lossy(&x.bytes).trim().to_string()).unwrap_or_default(),"available":o.map(|x|x.ok).unwrap_or(false)})); }
        "projects" => { return Ok(std::fs::read(config_path).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok()).unwrap_or(json!([]))); }
        "saveProjects" => { let projects=args["projects"].as_array().ok_or("项目列表无效")?; if projects.len()>50{return Err("最多保留 50 个最近项目".into());} std::fs::write(config_path,serde_json::to_vec(projects).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?; return Ok(json!(true)); }
        "inspect" => {
            if !root.is_dir(){return Err("文件夹不存在或无法访问".into());}
            let canonical=std::fs::canonicalize(root).map_err(|e|e.to_string())?;
            let found=g.run(&["rev-parse","--show-toplevel"])?;
            return Ok(json!({"path":canonical.to_string_lossy().trim_start_matches("\\\\?\\"),"repository":if found.ok {String::from_utf8_lossy(&found.bytes).trim().to_string()} else {String::new()},"error":if !found.ok && !found.error.contains("not a git repository") {found.error} else {String::new()}}));
        }
        "init" => { let found=g.run(&["rev-parse","--show-toplevel"])?; if found.ok{return Err("该目录已属于一个仓库，请打开现有仓库，避免嵌套创建。".into());} g.bytes(&["init","-b","main"])?; return Ok(json!(true)); }
        "clone" => {
            if !root.is_dir() { return Err("保存位置不存在".into()); }
            let url = arg(&args, "url"); check_url(url)?;
            let name = arg(&args, "name");
            if name.is_empty() || name == ".." || name == "." || name.starts_with('-') || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) { return Err("无效的文件夹名".into()); }
            let dest = root.join(name);
            if dest.exists() && std::fs::read_dir(&dest).map(|mut d| d.next().is_some()).unwrap_or(true) { return Err("目标文件夹已存在且不为空，请换一个名字。".into()); }
            g.run_with_ok(&["clone", "--progress", "--", url, name], 900)?;
            return Ok(json!({"path": dest.to_string_lossy()}));
        }
        _ => {}
    }
    // All remaining operations require a real worktree, including .git-file worktrees.
    g.text(&["rev-parse","--show-toplevel"])?;
    match op {
        "status" => snapshot(&g),
        "diff" => diff(&g,&args),
        "stage" | "unstage" => {
            let mut files=selected(&args)?; if files.is_empty(){return Err("请先选择文件".into());}
            // 重命名要把新旧路径一起处理；用哈希表查找，几千个文件也不会变慢
            let olds:std::collections::HashMap<String,String>=parse_status(&g.bytes(&["status","--porcelain=v1","-z"])?).into_iter().filter_map(|s|Some((s["path"].as_str()?.to_string(),s["old"].as_str()?.to_string()))).collect();
            let extra:Vec<String>=files.iter().filter_map(|p|olds.get(p).cloned()).collect();
            for old in extra{files.push(file(&old)?.into());}
            files.sort();files.dedup();
            let head=g.run(&["rev-parse","--verify","HEAD"])?.ok;
            let base:Vec<&str>=if op=="stage"{vec!["add","--"]}else if head{vec!["reset","-q","HEAD","--"]}else{vec!["rm","--cached","-r","--ignore-unmatch","--"]};
            // Windows 命令行上限约 32767 字符，超过会报 os error 206，所以分批传给 Git
            for chunk in path_chunks(&files,24000){
                let mut command=base.clone(); command.extend(chunk.iter().map(String::as_str)); g.bytes(&command)?;
            }
            Ok(json!(true))
        }
        "prepareCommit" => staged(&g),
        "commit" => {
            let current=staged(&g)?; if current["token"]!=args["token"]{return Err("暂存内容已变化。请重新查看实际保存文件并确认。".into());}
            let amend = args["amend"] == true;
            if current["files"].as_array().unwrap().is_empty() && !amend {return Err("尚未准备保存任何文件".into());}
            if arg(&args,"message").trim().is_empty(){return Err("请填写版本说明".into());}
            let state=snapshot(&g)?; if state["files"].as_array().unwrap().iter().any(|f|f["conflict"]==true){return Err("请先解决冲突".into());}
            if state["operation"].as_str().unwrap_or("")!=""{return Err("请通过操作状态中的“继续”完成正在进行的操作。".into());}
            if amend { g.bytes(&["commit","--amend","-m",arg(&args,"message")])?; } else { g.bytes(&["commit","-m",arg(&args,"message")])?; }
            Ok(json!({"sha":g.text(&["rev-parse","HEAD"])?}))
        }
        "identity" => { let name=arg(&args,"name").trim();let email=arg(&args,"email").trim();if name.is_empty()||!email.contains('@')||email.contains(['\n','\r']){return Err("请填写姓名和有效邮箱".into());}g.bytes(&["config","--local","user.name",name])?;g.bytes(&["config","--local","user.email",email])?;Ok(json!(true)) }
        "history" => {
            if !g.run(&["rev-parse","--verify","HEAD"])?.ok {return Ok(json!([]));}
            let skip=args["skip"].as_u64().unwrap_or(0).min(1_000_000).to_string();
            let mut cmd=vec!["log","-50","--skip",&skip,"--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%b%x00%D%x00"];
            let q=arg(&args,"q").trim(); let by_author=arg(&args,"mode")=="author";
            let qs=if by_author {format!("--author={q}")} else {format!("--grep={q}")};
            if !q.is_empty(){cmd.push(&qs);cmd.push("--regexp-ignore-case");if !by_author{cmd.push("--fixed-strings");}}
            let p=arg(&args,"file");if !p.is_empty(){file(p)?;cmd.extend(["--follow","--",p]);}
            let bytes=g.bytes(&cmd)?; let f:Vec<_>=bytes.split(|b|*b==0).collect(); let mut out=vec![];
            for c in f.chunks(7){if c.len()<7{break;}let get=|i:usize|String::from_utf8_lossy(c[i]).trim().to_string();out.push(json!({"sha":get(0),"parents":get(1),"author":get(2),"date":get(3),"subject":get(4),"body":get(5),"refs":get(6)}));}Ok(json!(out))
        }
        "commitFiles" => {let sha=g.revision(arg(&args,"sha"))?;Ok(json!(parse_names(&g.bytes(&["diff-tree","--root","--first-parent","-m","--no-commit-id","--name-status","-r","-z",&sha])?)))},
        "revert" => {g.clean()?;let sha=g.revision(arg(&args,"sha"))?;if g.text(&["rev-list","--parents","-n","1",&sha])?.split_whitespace().count()>2{return Err("这是合并提交。撤销需要选择主线父提交，为避免错误，本应用不执行此操作。请使用专业 Git 工具。".into());}g.bytes(&["revert","--no-edit",&sha])?;Ok(json!(true))},
        "discard" => {
            let p=file(arg(&args,"file"))?; let token=arg(&args,"token");let current=g.bytes(&["diff","--no-ext-diff","--no-textconv","--binary","--",p])?;
            if token!=fingerprint(&current){return Err("文件内容已变化，请重新预览并确认放弃范围".into());}
            let statuses=parse_status(&g.bytes(&["status","--porcelain=v1","-z"])?);let s=statuses.iter().find(|s|s["path"]==p).ok_or("文件状态已变化")?;
            if s["conflict"]==true||s["index"]=="?"||s["old"].is_string(){return Err("冲突、未跟踪和重命名文件不能直接放弃。请手动处理或先保存版本。".into());}
            g.bytes(&["restore","--worktree","--",p])?;Ok(json!(true))
        }
        "prepareDiscard" => {let p=file(arg(&args,"file"))?;Ok(json!({"token":fingerprint(&g.bytes(&["diff","--no-ext-diff","--no-textconv","--binary","--",p])?)}))},
        "operation"=>{let state=snapshot(&g)?;let operation=state["operation"].as_str().unwrap_or("");let action=arg(&args,"action");if !["merge","rebase","revert","cherry-pick"].contains(&operation)||!["continue","abort"].contains(&action){return Err("没有可处理的操作".into());}if action=="continue"&&state["files"].as_array().unwrap().iter().any(|f|f["conflict"]==true){return Err("请解决冲突并将相关文件准备保存后再继续".into());}let flag=format!("--{action}");if operation=="merge"&&action=="continue"{g.bytes(&["-c","core.editor=true","commit","--no-edit"])?;}else{g.bytes(&["-c","core.editor=true",operation,&flag])?;}Ok(json!(true))},
        "openFile"=>{let p=safe_local(root,arg(&args,"file"))?;let mut command=Command::new("explorer.exe");command.arg(p);#[cfg(windows)] command.creation_flags(0x08000000);command.spawn().map_err(|e|e.to_string())?;Ok(json!(true))},
        "export"=>{let sha=g.revision(arg(&args,"sha"))?;let p=file(arg(&args,"file"))?;let dest=Path::new(arg(&args,"dest"));let blob=format!("{sha}:{p}");let data=g.bytes(&["show",&blob])?;if data.len()>OUTPUT_LIMIT{return Err("文件超过导出限制".into());}std::fs::write(dest,data).map_err(|e|e.to_string())?;Ok(json!(true))},
        // ---------- 分支 ----------
        "branches" => {
            let text = g.text(&["branch", "--format=%(refname:short)%00%(HEAD)%00%(objectname:short)%00%(subject)%00%(upstream:short)%00%(upstream:track)"])?;
            Ok(json!(text.lines().filter(|l| !l.is_empty() && !l.starts_with('(')).map(|l| {
                let f: Vec<_> = l.split('\0').collect();
                json!({"name":f.first(),"current":f.get(1)==Some(&"*"),"sha":f.get(2),"subject":f.get(3),"upstream":f.get(4),"track":f.get(5)})
            }).collect::<Vec<_>>()))
        }
        "branchCreate" => {
            let name = branch_name(&g, arg(&args, "name"))?;
            let start = match args["from"].as_str().filter(|s| !s.is_empty()) { Some(s) => g.revision(s)?, None => g.revision("HEAD")? };
            if args["switch"] == true { g.bytes(&["switch", "-c", &name, &start])?; } else { g.bytes(&["branch", &name, &start])?; }
            Ok(json!(true))
        }
        "branchRename" => { let old = branch_name(&g, arg(&args, "name"))?; let new = branch_name(&g, arg(&args, "newName"))?; g.bytes(&["branch", "-m", &old, &new])?; Ok(json!(true)) }
        "branchDelete" => { let name = branch_name(&g, arg(&args, "name"))?; g.bytes(&["branch", if args["force"] == true { "-D" } else { "-d" }, &name])?; Ok(json!(true)) }
        "branchSwitch" => {
            let name = branch_name(&g, arg(&args, "name"))?;
            if args["stash"] == true { stash_dirty(&g, "切换分支前自动暂存")?; } else { g.clean()?; }
            g.bytes(&["switch", "--", &name])?; Ok(json!(true))
        }
        "merge" => { g.clean()?; let name = branch_name(&g, arg(&args, "name"))?; g.bytes(&["merge", "--no-edit", &name])?; Ok(json!(true)) }
        // ---------- 暂存修改 ----------
        "stashes" => {
            let text = g.text(&["stash", "list", "--format=%gd%x00%H%x00%gs%x00%ci"])?;
            Ok(json!(text.lines().filter(|l| !l.is_empty()).map(|l| { let f: Vec<_> = l.split('\0').collect(); json!({"id":f.first(),"sha":f.get(1),"subject":f.get(2),"date":f.get(3)}) }).collect::<Vec<_>>()))
        }
        "stashCreate" => { stash_dirty(&g, arg(&args, "message"))?; Ok(json!(true)) }
        "stashFiles" => { let sha = g.revision(arg(&args, "sha"))?; Ok(json!(parse_names(&g.bytes(&["diff", "--name-status", "-z", &format!("{sha}^1"), &sha])?))) }
        "stashApply" | "stashDrop" => {
            let sha = g.revision(arg(&args, "sha"))?;
            let list = g.text(&["stash", "list", "--format=%gd%x00%H"])?;
            let id = list.lines().find_map(|l| { let (id, s) = l.split_once('\0')?; if s == sha { Some(id.to_string()) } else { None } }).ok_or("暂存记录已经变化，请刷新")?;
            if op == "stashApply" { g.clean()?; g.bytes(&["stash", "apply", &id])?; if args["drop"] == true { g.bytes(&["stash", "drop", &id])?; } } else { g.bytes(&["stash", "drop", &id])?; }
            Ok(json!(true))
        }
        // ---------- 远程 ----------
        "remotes" => { let names = g.text(&["remote"])?; Ok(json!(names.lines().filter(|n| !n.is_empty()).map(|name| json!({"name":name,"url":g.optional(&["remote","get-url",name])})).collect::<Vec<_>>())) }
        "remoteSet" => {
            let name = arg(&args, "name"); let url = arg(&args, "url");
            if name.is_empty() || name.starts_with('-') || name.contains(char::is_whitespace) { return Err("无效远程名称".into()); }
            check_url(url)?;
            let exists = g.optional(&["remote"]).lines().any(|n| n == name);
            g.bytes(&if exists { vec!["remote", "set-url", name, url] } else { vec!["remote", "add", name, url] })?; Ok(json!(true))
        }
        "remoteRemove" => { let name = arg(&args, "name"); if name.starts_with('-') || name.is_empty() { return Err("无效远程名称".into()); } g.bytes(&["remote", "remove", name])?; Ok(json!(true)) }
        "fetch" | "pull" | "push" => {
            let name = arg(&args, "remote");
            if !g.text(&["remote"])?.lines().any(|n| n == name) { return Err("请选择已配置的远程仓库".into()); }
            match op {
                "fetch" => { g.run_with_ok(&["fetch", "--prune", name], 600)?; }
                "pull" => {
                    g.clean()?;
                    let branch = g.text(&["symbolic-ref", "--quiet", "--short", "HEAD"]).map_err(|_| "当前不在任何分支上，请先切换到一个分支")?;
                    let mode = match arg(&args, "mode") { "rebase" => "--rebase", "ff" => "--ff-only", _ => "--no-rebase" };
                    g.run_with_ok(&["pull", "--no-edit", mode, name, &branch], 600)?;
                }
                _ => {
                    let branch = g.text(&["symbolic-ref", "--quiet", "--short", "HEAD"]).map_err(|_| "当前不在任何分支上，请先创建并切换到一个分支")?;
                    g.run_with_ok(&["push", "--set-upstream", name, &branch], 600)?; // 永不强制推送
                }
            }
            Ok(json!(true))
        }
        // ---------- 标签 ----------
        "tags" => {
            let text = g.text(&["tag", "-l", "--sort=-creatordate", "--format=%(refname:short)%00%(objectname:short)%00%(contents:subject)%00%(creatordate:short)"])?;
            Ok(json!(text.lines().filter(|l| !l.is_empty()).take(300).map(|l| { let f: Vec<_> = l.split('\0').collect(); json!({"name":f.first(),"sha":f.get(1),"subject":f.get(2),"date":f.get(3)}) }).collect::<Vec<_>>()))
        }
        "tagCreate" => {
            let name = arg(&args, "name"); if name.starts_with('-') || name.is_empty() { return Err("无效标签名".into()); }
            g.bytes(&["check-ref-format", &format!("refs/tags/{name}")])?;
            let start = match args["sha"].as_str().filter(|s| !s.is_empty()) { Some(s) => g.revision(s)?, None => g.revision("HEAD")? };
            let msg = arg(&args, "message").trim();
            g.bytes(&if msg.is_empty() { vec!["tag", name, &start] } else { vec!["tag", "-a", name, "-m", msg, &start] })?; Ok(json!(true))
        }
        "tagDelete" => { let name = arg(&args, "name"); if name.starts_with('-') || name.is_empty() { return Err("无效标签名".into()); } g.bytes(&["tag", "-d", name])?; Ok(json!(true)) }
        // ---------- 回到某个版本 / 复制 / 记录 ----------
        "resetLastSoft" => {
            if !g.run(&["rev-parse", "--verify", "HEAD"])?.ok { return Err("还没有可撤销的版本".into()); }
            if g.run(&["rev-parse", "--verify", "HEAD~1"])?.ok { g.bytes(&["reset", "--soft", "HEAD~1"])?; } else { g.bytes(&["update-ref", "-d", "HEAD"])?; }
            Ok(json!(true))
        }
        "resetTo" => {
            let sha = g.revision(arg(&args, "sha"))?;
            match arg(&args, "mode") {
                "soft" => { g.bytes(&["reset", "--soft", &sha])?; }
                "mixed" => { g.bytes(&["reset", "--mixed", &sha])?; }
                "hard" => {
                    let branch = g.optional(&["symbolic-ref", "--quiet", "--short", "HEAD"]);
                    let expect = if branch.is_empty() { "HEAD".to_string() } else { branch };
                    if arg(&args, "confirm") != expect { return Err(format!("确认文字不正确，请输入“{expect}”")); }
                    g.clean()?; g.bytes(&["reset", "--hard", &sha])?;
                }
                _ => return Err("无效的回退方式".into()),
            }
            Ok(json!(true))
        }
        "cherryPick" => {
            g.clean()?; let sha = g.revision(arg(&args, "sha"))?;
            if g.text(&["rev-list", "--parents", "-n", "1", &sha])?.split_whitespace().count() > 2 { return Err("这是合并版本，无法直接复制。".into()); }
            g.bytes(&["cherry-pick", &sha])?; Ok(json!(true))
        }
        "reflog" => {
            let text = g.text(&["reflog", "-n", "40", "--format=%H%x00%gd%x00%gs%x00%ci"])?;
            Ok(json!(text.lines().filter(|l| !l.is_empty()).map(|l| { let f: Vec<_> = l.split('\0').collect(); json!({"sha":f.first(),"ref":f.get(1),"subject":f.get(2),"date":f.get(3)}) }).collect::<Vec<_>>()))
        }
        // ---------- 冲突 ----------
        "resolve" => {
            let p = file(arg(&args, "file"))?; let side = match arg(&args, "side") { "ours" => "--ours", "theirs" => "--theirs", _ => return Err("无效选项".into()) };
            let statuses = parse_status(&g.bytes(&["status", "--porcelain=v1", "-z"])?);
            if !statuses.iter().any(|s| s["path"] == p && s["conflict"] == true) { return Err("该文件当前没有冲突".into()); }
            g.bytes(&["checkout", side, "--", p])?; g.bytes(&["add", "--", p])?; Ok(json!(true))
        }
        // ---------- 逐行追溯 ----------
        "blame" => {
            let p = file(arg(&args, "file"))?;
            let sha = match args["sha"].as_str().filter(|s| !s.is_empty()) { Some(s) => Some(g.revision(s)?), None => None };
            let mut cmd = vec!["blame".to_string(), "--porcelain".into()]; if let Some(s) = &sha { cmd.push(s.clone()); } cmd.push("--".into()); cmd.push(p.into());
            let bytes = g.bytes(&cmd.iter().map(String::as_str).collect::<Vec<_>>())?;
            Ok(parse_blame(&bytes))
        }
        // ---------- 按代码块暂存 ----------
        "applyHunk" => {
            let p = file(arg(&args, "file"))?; let unstage = arg(&args, "mode") == "unstage"; let index = args["index"].as_u64().ok_or("缺少代码块序号")? as usize;
            let mut d = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3"]; if unstage { d.push("--cached"); } d.push("--"); d.push(p);
            let patch = hunk_patch(&g.bytes(&d)?, index).ok_or("这个代码块已经变化，请刷新后重试")?;
            let mut a = vec!["apply", "--cached", "--recount", "--whitespace=nowarn"]; if unstage { a.push("-R"); } a.push("-");
            let o = g.run_with(&a, Some(&patch), 60)?; if !o.ok { return Err(classify(&failure_text(&o))); }
            Ok(json!(true))
        }
        "openFolder" => { let mut command = Command::new("explorer.exe"); command.arg(std::fs::canonicalize(root).map_err(|e| e.to_string())?); #[cfg(windows)] command.creation_flags(0x08000000); command.spawn().map_err(|e| e.to_string())?; Ok(json!(true)) }
        _=>Err("不支持的操作".into())
    }
}

/// 把路径按命令行长度分批；每批总长不超过 limit 个字符（单个路径超长时独占一批）。
fn path_chunks(files: &[String], limit: usize) -> Vec<&[String]> {
    let (mut out, mut start, mut len) = (vec![], 0usize, 0usize);
    for (i, f) in files.iter().enumerate() {
        let cost = f.chars().count() + 3;
        if i > start && len + cost > limit { out.push(&files[start..i]); start = i; len = 0; }
        len += cost;
    }
    if start < files.len() { out.push(&files[start..]); }
    out
}
/// 校验并返回合法的分支名（拒绝以 - 开头、含非法字符的名称）。
fn branch_name(g: &Git, value: &str) -> Result<String, String> {
    if value.is_empty() || value.starts_with('-') || value.len() > 200 { return Err("无效分支名".into()); }
    g.bytes(&["check-ref-format", "--branch", value])?; Ok(value.to_string())
}
/// 远程地址检查：不允许把密码或令牌写进网址。
fn check_url(url: &str) -> Result<(), String> {
    if url.is_empty() || url.starts_with('-') || url.contains(['\n', '\r', ' ']) { return Err("无效远程地址".into()); }
    if url.contains("://") && url.split("://").nth(1).unwrap_or("").split('/').next().unwrap_or("").contains('@') { return Err("请勿把密码或令牌放进网址；使用 Git 凭据管理器登录。".into()); }
    Ok(())
}
/// 把当前所有修改（含新文件）存入暂存栈；没有修改时报错。
fn stash_dirty(g: &Git, message: &str) -> Result<(), String> {
    if g.bytes(&["status", "--porcelain=v1", "-z"])?.is_empty() { return Err("没有需要暂存的修改".into()); }
    if !g.run(&["rev-parse", "--verify", "HEAD"])?.ok { return Err("请先保存第一个版本，再使用暂存修改。".into()); }
    let msg = if message.trim().is_empty() { "暂存的修改" } else { message.trim() };
    g.bytes(&["stash", "push", "--include-untracked", "-m", msg])?; Ok(())
}
/// 解析 `git blame --porcelain`，最多返回 3000 行。
fn parse_blame(bytes: &[u8]) -> Value {
    use std::collections::HashMap;
    let text = String::from_utf8_lossy(bytes);
    let mut info: HashMap<String, (String, String, String)> = HashMap::new();
    let (mut rows, mut cur, mut total) = (vec![], String::new(), 0usize);
    for line in text.lines() {
        if let Some(content) = line.strip_prefix('\t') {
            total += 1;
            if rows.len() < 3000 { let (a, t, s) = info.get(&cur).cloned().unwrap_or_default(); rows.push(json!({"sha":cur.chars().take(7).collect::<String>(),"author":a,"time":t,"summary":s,"text":content})); }
        } else if line.len() > 40 && line.as_bytes()[..40].iter().all(|b| b.is_ascii_hexdigit()) && line.as_bytes()[40] == b' ' {
            cur = line[..40].to_string(); info.entry(cur.clone()).or_default();
        } else if let Some(v) = line.strip_prefix("author ") { info.entry(cur.clone()).or_default().0 = v.to_string(); }
        else if let Some(v) = line.strip_prefix("author-time ") { info.entry(cur.clone()).or_default().1 = v.to_string(); }
        else if let Some(v) = line.strip_prefix("summary ") { info.entry(cur.clone()).or_default().2 = v.to_string(); }
    }
    json!({"rows":rows,"total":total,"limited":total>3000})
}
/// 从单个文件的 diff 中取出文件头 + 第 index 个代码块，组成可 `git apply` 的补丁。
fn hunk_patch(diff: &[u8], index: usize) -> Option<Vec<u8>> {
    let lines: Vec<&[u8]> = diff.split_inclusive(|b| *b == b'\n').collect();
    let starts: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| l.starts_with(b"@@")).map(|(i, _)| i).collect();
    let first = *starts.first()?; let begin = *starts.get(index)?; let end = starts.get(index + 1).copied().unwrap_or(lines.len());
    let mut patch: Vec<u8> = lines[..first].concat();
    patch.extend(lines[begin..end].concat());
    if !patch.ends_with(b"\n") { patch.push(b'\n'); }
    Some(patch)
}

#[cfg(test)] mod tests {
    use super::*;
    fn repo() -> (PathBuf,Arc<AtomicU64>) {let dir=std::env::temp_dir().join(format!("paper-git-test-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));std::fs::create_dir_all(&dir).unwrap();let cancel=Arc::new(AtomicU64::new(0));let g=Git{root:&dir,cancel:&cancel,generation:0};g.bytes(&["init","-b","main"]).unwrap();g.bytes(&["config","user.name","测试"]).unwrap();g.bytes(&["config","user.email","test@example.com"]).unwrap();(dir,cancel)}
    #[test] fn parses_unicode_rename_and_conflicts(){let s=parse_status("R  新 文件.txt\0旧 文件.txt\0 M 中文.txt\0?? 新增.txt\0UU 冲突.txt\0".as_bytes());assert_eq!(s.len(),4);assert_eq!(s[0]["old"],"旧 文件.txt");assert_eq!(s[3]["conflict"],true);}
    #[test] fn rejects_unsafe_paths(){for p in ["../secret","C:\\secret","a/../../b",".git/config","x/.GIT/index"]{assert!(file(p).is_err(),"{p}");}assert!(file("文档/空 格 & $.txt").is_ok());}
    #[test] fn first_commit_staged_and_worktree_are_separate(){let (dir,cancel)=repo();let g=Git{root:&dir,cancel:&cancel,generation:0};let p="中文 空格 & $.txt";std::fs::write(dir.join(p),"版本一\n").unwrap();g.bytes(&["add","--",p]).unwrap();let first=staged(&g).unwrap();std::fs::write(dir.join(p),"版本二\n").unwrap();assert_eq!(first["token"],staged(&g).unwrap()["token"]);g.bytes(&["commit","-m","首次保存"]).unwrap();assert_eq!(g.text(&["show",&format!("HEAD:{p}")]).unwrap(),"版本一");assert_eq!(snapshot(&g).unwrap()["files"][0]["worktree"],"M");g.bytes(&["add","--",p]).unwrap();assert_ne!(first["token"],staged(&g).unwrap()["token"]);std::fs::remove_dir_all(dir).unwrap();}
    #[test] fn binary_and_unborn_diff(){let (dir,cancel)=repo();let g=Git{root:&dir,cancel:&cancel,generation:0};std::fs::write(dir.join("图.bin"),[0,1,2,3]).unwrap();assert_eq!(diff(&g,&json!({"file":"图.bin","mode":"untracked"})).unwrap()["binary"],true);g.bytes(&["add","--","图.bin"]).unwrap();assert_eq!(diff(&g,&json!({"file":"图.bin","mode":"index"})).unwrap()["binary"],true);std::fs::remove_dir_all(dir).unwrap();}

    fn g<'a>(dir: &'a PathBuf, cancel: &'a Arc<AtomicU64>) -> Git<'a> { Git { root: dir, cancel, generation: 0 } }
    fn commit_file(g: &Git, dir: &PathBuf, name: &str, text: &str, msg: &str) { std::fs::write(dir.join(name), text).unwrap(); g.bytes(&["add", "--", name]).unwrap(); g.bytes(&["commit", "-qm", msg]).unwrap(); }

    #[test] fn url_and_branch_validation() {
        assert!(check_url("https://github.com/a/b.git").is_ok());
        assert!(check_url("https://user:token@github.com/a/b.git").is_err());
        assert!(check_url("--upload-pack=evil").is_err());
        assert!(check_url("a b").is_err());
        let (dir, cancel) = repo(); let g = g(&dir, &cancel);
        assert!(branch_name(&g, "feature/中文-1").is_ok());
        for bad in ["-x", "a..b", "a b", "", "x~1"] { assert!(branch_name(&g, bad).is_err(), "{bad}"); }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test] fn hunk_stage_and_unstage() {
        let (dir, cancel) = repo(); let g = g(&dir, &cancel);
        let base: String = (1..=40).map(|i| format!("行{i}\n")).collect();
        commit_file(&g, &dir, "文 件.txt", &base, "base");
        let changed = base.replace("行2\n", "行2改\n").replace("行38\n", "行38改\n");
        std::fs::write(dir.join("文 件.txt"), changed).unwrap();
        let d = g.bytes(&["diff", "--no-color", "-U3", "--", "文 件.txt"]).unwrap();
        assert!(hunk_patch(&d, 2).is_none(), "只有两个代码块");
        let patch = hunk_patch(&d, 1).unwrap();
        assert!(g.run_with(&["apply", "--cached", "--recount", "--whitespace=nowarn", "-"], Some(&patch), 30).unwrap().ok);
        let cached = String::from_utf8(g.bytes(&["diff", "--cached", "--no-color"]).unwrap()).unwrap();
        assert!(cached.contains("行38改") && !cached.contains("行2改"), "只暂存第二个代码块");
        let work = String::from_utf8(g.bytes(&["diff", "--no-color"]).unwrap()).unwrap();
        assert!(work.contains("行2改") && !work.contains("行38改"), "第一个代码块仍未暂存");
        // 取消暂存该代码块
        let dc = g.bytes(&["diff", "--cached", "--no-color", "-U3", "--", "文 件.txt"]).unwrap();
        let back = hunk_patch(&dc, 0).unwrap();
        assert!(g.run_with(&["apply", "--cached", "-R", "--recount", "--whitespace=nowarn", "-"], Some(&back), 30).unwrap().ok);
        assert!(g.bytes(&["diff", "--cached", "--name-only"]).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test] fn blame_reports_author_and_summary() {
        let (dir, cancel) = repo(); let g = g(&dir, &cancel);
        commit_file(&g, &dir, "a.txt", "一\n二\n", "第一次");
        commit_file(&g, &dir, "a.txt", "一\n二\n三\n", "第二次");
        let v = parse_blame(&g.bytes(&["blame", "--porcelain", "--", "a.txt"]).unwrap());
        assert_eq!(v["total"], 3);
        assert_eq!(v["rows"][0]["summary"], "第一次");
        assert_eq!(v["rows"][2]["summary"], "第二次");
        assert_eq!(v["rows"][2]["author"], "测试");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test] fn stash_includes_untracked_and_restores() {
        let (dir, cancel) = repo(); let g = g(&dir, &cancel);
        assert!(stash_dirty(&g, "x").is_err(), "没有修改时应报错");
        commit_file(&g, &dir, "a.txt", "1\n", "init");
        std::fs::write(dir.join("a.txt"), "2\n").unwrap(); std::fs::write(dir.join("新.txt"), "n\n").unwrap();
        stash_dirty(&g, "临时").unwrap();
        assert!(g.bytes(&["status", "--porcelain"]).unwrap().is_empty() && !dir.join("新.txt").exists());
        g.bytes(&["stash", "pop"]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap().trim(), "2");
        assert!(dir.join("新.txt").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test] fn first_commit_can_be_undone_softly() {
        let (dir, cancel) = repo(); let g = g(&dir, &cancel);
        commit_file(&g, &dir, "a.txt", "1\n", "only");
        g.bytes(&["update-ref", "-d", "HEAD"]).unwrap();
        assert!(!g.run(&["rev-parse", "--verify", "HEAD"]).unwrap().ok);
        assert!(g.text(&["diff", "--cached", "--name-only"]).unwrap().contains("a.txt"), "修改仍保留为已准备保存");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test] fn remote_push_fetch_pull_and_counts() {
        let (a, ca) = repo(); let ga = g(&a, &ca);
        let bare = std::env::temp_dir().join(format!("paper-git-bare-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&bare).unwrap();
        Command::new("git").args(["init", "-q", "--bare", "-b", "main"]).arg(&bare).output().unwrap();
        commit_file(&ga, &a, "a.txt", "1\n", "one");
        ga.bytes(&["remote", "add", "origin", bare.to_str().unwrap()]).unwrap();
        ga.run_with_ok(&["push", "--set-upstream", "origin", "main"], 60).unwrap();
        // 第二份克隆提交一个新版本并上传
        let b = std::env::temp_dir().join(format!("paper-git-clone-{}", std::process::id()));
        let cb = Arc::new(AtomicU64::new(0)); std::fs::create_dir_all(&b).unwrap();
        let gb = g(&b, &cb);
        Command::new("git").args(["clone", "-q"]).arg(&bare).arg(b.join("c")).output().unwrap();
        let bc = b.join("c"); let gc = Git { root: &bc, cancel: &cb, generation: 0 };
        gc.bytes(&["config", "user.name", "乙"]).unwrap(); gc.bytes(&["config", "user.email", "b@e.com"]).unwrap();
        commit_file(&gc, &bc, "b.txt", "2\n", "two"); gc.run_with_ok(&["push", "origin", "main"], 60).unwrap();
        // A 获取后应落后 1、领先 0
        ga.run_with_ok(&["fetch", "--prune", "origin"], 60).unwrap();
        let s = snapshot(&ga).unwrap(); assert_eq!(s["behind"], 1); assert_eq!(s["ahead"], 0); assert_eq!(s["upstream"], "origin/main");
        // A 本地再提交 → 与远程分叉；直接推送应被拒绝且给出“远程拒绝”提示
        commit_file(&ga, &a, "c.txt", "3\n", "three");
        let err = ga.run_with_ok(&["push", "origin", "main"], 60).unwrap_err(); assert!(err.contains("远程拒绝上传"), "{err}");
        // 拉取（合并）后再上传成功
        ga.run_with_ok(&["pull", "--no-edit", "--no-rebase", "origin", "main"], 60).unwrap();
        ga.run_with_ok(&["push", "origin", "main"], 60).unwrap();
        let s = snapshot(&ga).unwrap(); assert_eq!(s["ahead"], 0); assert_eq!(s["behind"], 0);
        for d in [a, b, bare] { let _ = std::fs::remove_dir_all(d); }
    }

    #[test] fn detached_head_counts_orphan_commits() {
        let (dir, cancel) = repo(); let g = g(&dir, &cancel);
        commit_file(&g, &dir, "a.txt", "1\n", "one");
        g.bytes(&["checkout", "-q", "--detach"]).unwrap();
        commit_file(&g, &dir, "a.txt", "2\n", "two");
        let s = snapshot(&g).unwrap(); assert_eq!(s["detached"], true); assert_eq!(s["orphan"], 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test] fn merge_conflict_is_reported_as_conflict() {
        let (dir, cancel) = repo(); let g = g(&dir, &cancel);
        commit_file(&g, &dir, "f.txt", "base
", "base");
        g.bytes(&["checkout", "-q", "-b", "x"]).unwrap(); commit_file(&g, &dir, "f.txt", "X
", "x");
        g.bytes(&["checkout", "-q", "main"]).unwrap(); commit_file(&g, &dir, "f.txt", "M
", "m");
        let err = g.bytes(&["merge", "--no-edit", "x"]).unwrap_err();
        assert!(err.contains("存在冲突"), "冲突提示应来自 stdout 的 CONFLICT 行: {err}");
        assert_eq!(snapshot(&g).unwrap()["operation"], "merge");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test] fn path_chunks_respect_limit_and_keep_everything() {
        let files: Vec<String> = (0..8000).map(|i| format!("很长的目录名/子目录/文件{i}.txt")).collect();
        let chunks = path_chunks(&files, 24000);
        assert!(chunks.len() > 1);
        assert_eq!(chunks.iter().map(|c| c.len()).sum::<usize>(), 8000, "不丢文件");
        for c in &chunks { assert!(c.iter().map(|f| f.chars().count() + 3).sum::<usize>() <= 24000 + 100); }
        assert_eq!(path_chunks(&["a".to_string()], 10).len(), 1);
        assert!(path_chunks(&[], 10).is_empty());
    }

    #[test] fn stage_thousands_of_files_in_batches() {
        let (dir, cancel) = repo(); let g = g(&dir, &cancel);
        std::fs::create_dir_all(dir.join("一个相当长的目录名称用来撑满命令行")).unwrap();
        let names: Vec<String> = (0..3000).map(|i| format!("一个相当长的目录名称用来撑满命令行/文件编号{i:05}.txt")).collect();
        for n in &names { std::fs::write(dir.join(n), "x").unwrap(); }
        for c in path_chunks(&names, 24000) { let mut cmd = vec!["add", "--"]; cmd.extend(c.iter().map(String::as_str)); g.bytes(&cmd).unwrap(); }
        assert_eq!(g.text(&["diff", "--cached", "--name-only"]).unwrap().lines().count(), 3000);
        // 一次性传入全部路径会超过命令行上限
        let mut all = vec!["add", "--"]; all.extend(names.iter().map(String::as_str));
        assert!(g.run(&all).is_err(), "不分批应触发 os error 206");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
