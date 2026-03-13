#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use tauri::{WebviewUrl, WebviewWindowBuilder};

const DASHBOARD_HOST: &str = "127.0.0.1";
const DASHBOARD_PORT: u16 = 4174;
const DASHBOARD_READY_PATH: &str = "/api/operator";
const STARTUP_ATTEMPTS: usize = 80;
const STARTUP_POLL_INTERVAL_MS: u64 = 250;

fn start_local_stack(repo_root: &Path) {
    #[cfg(target_os = "windows")]
    {
        let script = repo_root.join("scripts").join("stack.ps1");
        let _ = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &script.to_string_lossy(),
                "start",
            ])
            .env("STHYRA_AUTO_OPEN", "0")
            .current_dir(repo_root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let script = repo_root.join("scripts").join("stack.sh");
        let _ = Command::new(script)
            .arg("start")
            .env("STHYRA_AUTO_OPEN", "0")
            .current_dir(repo_root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(repo_root) = resolve_repo_root() {
                start_local_stack(&repo_root);
            } else {
                eprintln!("sthyra-desktop-shell: unable to locate repository root; skipping stack bootstrap");
            }

            let app_handle = app.handle().clone();
            thread::spawn(move || {
                let dashboard_url = dashboard_url();

                for _ in 0..STARTUP_ATTEMPTS {
                    if dashboard_ready() {
                        let _ = WebviewWindowBuilder::new(
                            &app_handle,
                            "main",
                            WebviewUrl::External(dashboard_url.parse().expect("valid dashboard url")),
                        )
                        .title("NyraQ")
                        .inner_size(1600.0, 1024.0)
                        .min_inner_size(1280.0, 800.0)
                        .build();
                        return;
                    }
                    thread::sleep(Duration::from_millis(STARTUP_POLL_INTERVAL_MS));
                }

                let _ = WebviewWindowBuilder::new(
                    &app_handle,
                    "main",
                    WebviewUrl::App("index.html".into()),
                )
                .title("NyraQ")
                .inner_size(1000.0, 700.0)
                .build();
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn dashboard_url() -> String {
    format!("http://{DASHBOARD_HOST}:{DASHBOARD_PORT}")
}

fn dashboard_ready() -> bool {
    let Some(address) = resolve_dashboard_socket() else {
        return false;
    };

    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(400)) else {
        return false;
    };

    let request = format!(
        "GET {DASHBOARD_READY_PATH} HTTP/1.1\r\nHost: {DASHBOARD_HOST}:{DASHBOARD_PORT}\r\nConnection: close\r\n\r\n"
    );

    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn resolve_dashboard_socket() -> Option<SocketAddr> {
    (DASHBOARD_HOST, DASHBOARD_PORT)
        .to_socket_addrs()
        .ok()?
        .next()
}

fn resolve_repo_root() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(repo_root) = env::var("STHYRA_REPO_ROOT") {
        candidates.push(PathBuf::from(repo_root));
    }

    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir);
    }

    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    for candidate in candidates {
        if let Some(repo_root) = walk_for_repo_root(&candidate) {
            return Some(repo_root);
        }
    }

    None
}

fn walk_for_repo_root(start: &Path) -> Option<PathBuf> {
    for candidate in start.ancestors() {
        // Accept the repo root if either platform stack script exists alongside apps/desktop
        let has_apps_desktop = candidate.join("apps").join("desktop").exists();
        let has_stack = candidate.join("scripts").join("stack.sh").exists()
            || candidate.join("scripts").join("stack.ps1").exists();

        if has_apps_desktop && has_stack {
            return Some(candidate.to_path_buf());
        }
    }

    None
}
