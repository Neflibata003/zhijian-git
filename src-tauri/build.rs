fn main() {
    // 图标文件变化时必须重新嵌入 exe 资源，否则 Cargo 会沿用旧图标
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
