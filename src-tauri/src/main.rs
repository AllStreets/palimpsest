// Palimpsest's Mac shell. The city is drawn by a local engine that runs as a launchd agent on
// 127.0.0.1:4770; this window shows a splash, waits briefly for that engine, then opens its UI.
// When the engine is not running the splash offers to install and start it, and when macOS
// keeps the app out of the folder holding the repo, it says so and points to the setting. Links the city opens
// in a new window (the inspector's pull request links) go to the default browser instead.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{AppHandle, Manager, Theme, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const PORT: u16 = 4770;

/// The repo this app was built from: the engine runs from its source, so it is baked in.
const REPO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

/// The node that built the app, found on the build shell's PATH (see build.rs).
const BUILD_NODE: &str = env!("PALIMPSEST_BUILD_NODE");

/// The sky's zenith as the city renders it (sky.ts zenith through ACES at exposure 0.85).
const ZENITH: Color = Color(0x1f, 0x2b, 0x4e, 0xff);

fn base() -> String {
    format!("http://127.0.0.1:{PORT}/")
}

fn repo() -> PathBuf {
    PathBuf::from(REPO).canonicalize().unwrap_or_else(|_| PathBuf::from(REPO))
}

/// True when the engine answers its health check, not merely when something holds the port.
/// The check blocks for up to 800ms, so it runs off the main thread, which keeps the window live.
#[tauri::command]
async fn engine_healthy() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        ureq::get(&format!("{}api/health", base()))
            .timeout(Duration::from_millis(800))
            .call()
            .ok()
            .and_then(|r| r.into_string().ok())
            .map(|body| body.contains("\"ok\":true"))
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// Swaps the splash for the city.
#[tauri::command]
fn open_city(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("the window is gone")?;
    window.navigate(Url::parse(&base()).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// A node new enough for the engine: the one that built the app, then the usual install places,
/// then whatever a login shell finds.
fn find_node() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from(BUILD_NODE),
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
    ];
    if let Ok(out) = Command::new("/bin/zsh").args(["-lc", "command -v node"]).output() {
        let found = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !found.is_empty() {
            candidates.push(PathBuf::from(found));
        }
    }
    candidates.push(PathBuf::from(format!("{home}/.volta/bin/node")));
    candidates.into_iter().find(|p| !p.as_os_str().is_empty() && p.is_file())
}

/// Why Start the engine failed, as the splash tells it apart: macOS refusing this app the folder
/// the repo sits in needs a different remedy from every other failure.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum InstallError {
    /// macOS privacy (Files and Folders) will not let Palimpsest read the repo. `folder` names it.
    FolderAccess { folder: String },
    /// Anything else, in the command's own words.
    Failed { message: String },
}

/// macOS answers EPERM (errno 1) when privacy settings hold a folder back from an app, and node
/// names it by its code. launchctl also says "Operation not permitted" for its own unrelated
/// failures (and never "EPERM"), so only node's code counts, and never on a launchctl line.
fn says_not_permitted(text: &str) -> bool {
    text.lines().any(|line| line.contains("EPERM") && !line.to_lowercase().contains("launchctl"))
}

/// `s` as one word for the shell: as it is when every character is plain, otherwise in single
/// quotes, so spaces, quotes and characters like `$` or `;` reach node as part of the path.
fn sh_quote(s: &str) -> String {
    let plain = |c: char| c.is_ascii_alphanumeric() || "/._-+,@%:".contains(c);
    if !s.is_empty() && s.chars().all(plain) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// The line a person can paste into Terminal to start the engine by hand, from any folder.
/// A repo under the home folder is written with `~`, which Terminal expands, to keep it short;
/// the `~/` stays outside any quotes so it still expands.
fn by_hand_command(repo: &Path, home: &Path) -> String {
    let script = repo.join("bin").join("palimpsest.mjs");
    let at = match script.strip_prefix(home) {
        Ok(rest) if !home.as_os_str().is_empty() => format!("~/{}", sh_quote(&rest.display().to_string())),
        _ => sh_quote(&script.display().to_string()),
    };
    format!("node {at} engine install")
}

/// The by-hand start command with this Mac's repo path, for the splash's ledger.
#[tauri::command]
fn engine_command() -> String {
    by_hand_command(&repo(), Path::new(&std::env::var("HOME").unwrap_or_default()))
}

/// The folder a person would look for in Files and Folders: Downloads, Documents or Desktop when
/// the repo sits inside one, otherwise the folder that holds the repo.
fn protected_folder(repo: &Path, home: &Path) -> String {
    for name in ["Downloads", "Documents", "Desktop"] {
        if repo.starts_with(home.join(name)) {
            return name.to_string();
        }
    }
    repo.parent().unwrap_or(repo).display().to_string()
}

/// Reads what `engine install` left behind: success, a privacy refusal, or any other failure.
fn classify_install(succeeded: bool, stderr: &str, exit: &str, folder: &str) -> Result<(), InstallError> {
    if succeeded {
        return Ok(());
    }
    if says_not_permitted(stderr) {
        return Err(InstallError::FolderAccess { folder: folder.to_string() });
    }
    let said = stderr.trim();
    Err(InstallError::Failed {
        message: if said.is_empty() { format!("The install exited with {exit}.") } else { said.to_string() },
    })
}

/// True when an I/O error is macOS privacy holding the folder back (EPERM).
fn io_not_permitted(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(1)
}

fn failed(message: impl Into<String>) -> InstallError {
    InstallError::Failed { message: message.into() }
}

/// Writes the launchd agent and starts it: `node <repo>/bin/palimpsest.mjs engine install`.
/// Before running node it reads the script itself, so a privacy refusal is caught (and macOS can
/// ask for access) here rather than inside node.
#[tauri::command]
async fn install_engine() -> Result<(), InstallError> {
    tauri::async_runtime::spawn_blocking(|| {
        let repo = repo();
        let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
        let folder = protected_folder(&repo, &home);
        let denied = || InstallError::FolderAccess { folder: folder.clone() };
        let script = repo.join("bin").join("palimpsest.mjs");
        if let Err(e) = std::fs::File::open(&script).and_then(|mut f| f.read(&mut [0u8; 1])) {
            return Err(if io_not_permitted(&e) {
                denied()
            } else if e.kind() == std::io::ErrorKind::NotFound {
                failed(format!("The engine's source is missing from {}.", repo.display()))
            } else {
                failed(format!("Could not read {}: {e}", script.display()))
            });
        }
        let node = find_node().ok_or_else(|| failed("Could not find node on this Mac. Palimpsest needs Node 22.13 or newer."))?;
        // launchd hands the agent this PATH, so make sure node's own folder and Homebrew are on it.
        let node_dir = node.parent().map(|d| d.display().to_string()).unwrap_or_default();
        let path = format!(
            "{node_dir}:/opt/homebrew/bin:/usr/local/bin:{}",
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into())
        );
        let out = Command::new(&node)
            .arg(&script)
            .args(["engine", "install"])
            .current_dir(&repo)
            .env("PATH", path)
            .output()
            .map_err(|e| if io_not_permitted(&e) { denied() } else { failed(format!("Could not run node: {e}")) })?;
        classify_install(out.status.success(), &String::from_utf8_lossy(&out.stderr), &out.status.to_string(), &folder)
    })
    .await
    .map_err(|e| failed(e.to_string()))?
}

/// Opens System Settings at Privacy & Security, Files and Folders, where the person can let
/// Palimpsest into the folder that holds the repo.
#[tauri::command]
fn open_folder_access(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders", None::<&str>)
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![engine_healthy, open_city, install_engine, open_folder_access, engine_command])
        .setup(|app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Palimpsest")
                .inner_size(1600.0, 1000.0)
                .min_inner_size(1000.0, 640.0)
                .center()
                .theme(Some(Theme::Dark))
                .background_color(ZENITH)
                // target=_blank links leave the app for the default browser, never a second webview.
                .on_new_window(move |url, _features| {
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Palimpsest");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_is_ok_whatever_stderr_says() {
        assert_eq!(classify_install(true, "", "exit status: 0", "Downloads"), Ok(()));
        assert_eq!(classify_install(true, "warning: something", "exit status: 0", "Downloads"), Ok(()));
    }

    #[test]
    fn eperm_from_node_is_a_folder_access_refusal() {
        let stderr = "node:internal/modules/cjs/loader:1228\n  throw err;\nError: EPERM: operation not permitted, open '/Users/c/Downloads/palimpsest/bin/palimpsest.mjs'\n    errno: -1, code: 'EPERM'";
        assert_eq!(
            classify_install(false, stderr, "exit status: 1", "Downloads"),
            Err(InstallError::FolderAccess { folder: "Downloads".into() })
        );
    }

    #[test]
    fn eperm_from_nodes_working_folder_is_a_folder_access_refusal() {
        let stderr = "Error: EPERM: process.cwd failed with error operation not permitted";
        assert_eq!(
            classify_install(false, stderr, "exit status: 1", "Documents"),
            Err(InstallError::FolderAccess { folder: "Documents".into() })
        );
    }

    #[test]
    fn launchctl_saying_not_permitted_is_an_ordinary_failure() {
        let stderr = "launchctl bootstrap failed: Bootstrap failed: 1: Operation not permitted";
        assert_eq!(
            classify_install(false, stderr, "exit status: 1", "Downloads"),
            Err(InstallError::Failed { message: stderr.into() })
        );
        let stderr = "launchctl bootstrap failed: EPERM";
        assert_eq!(
            classify_install(false, stderr, "exit status: 1", "Downloads"),
            Err(InstallError::Failed { message: stderr.into() })
        );
    }

    #[test]
    fn the_by_hand_command_names_the_script_by_its_full_path() {
        let home = Path::new("/Users/c");
        assert_eq!(
            by_hand_command(Path::new("/Users/c/Downloads/palimpsest"), home),
            "node ~/Downloads/palimpsest/bin/palimpsest.mjs engine install"
        );
        assert_eq!(
            by_hand_command(Path::new("/Volumes/Work/palimpsest"), home),
            "node /Volumes/Work/palimpsest/bin/palimpsest.mjs engine install"
        );
        assert_eq!(
            by_hand_command(Path::new("/Users/c/code/palimpsest"), Path::new("")),
            "node /Users/c/code/palimpsest/bin/palimpsest.mjs engine install"
        );
    }

    #[test]
    fn the_by_hand_command_quotes_a_path_the_shell_would_split_or_read() {
        let home = Path::new("/Users/c");
        assert_eq!(
            by_hand_command(Path::new("/Users/c/My Code/palimpsest"), home),
            "node ~/'My Code/palimpsest/bin/palimpsest.mjs' engine install"
        );
        assert_eq!(
            by_hand_command(Path::new("/Volumes/Work Disk/palimpsest"), home),
            "node '/Volumes/Work Disk/palimpsest/bin/palimpsest.mjs' engine install"
        );
        assert_eq!(
            by_hand_command(Path::new("/Users/c/Connor's/palimpsest"), home),
            "node ~/'Connor'\\''s/palimpsest/bin/palimpsest.mjs' engine install"
        );
        assert_eq!(
            by_hand_command(Path::new("/Users/c/a$b;c/palimpsest"), home),
            "node ~/'a$b;c/palimpsest/bin/palimpsest.mjs' engine install"
        );
        assert_eq!(
            by_hand_command(Path::new("/Users/c/code (old)/palimpsest"), Path::new("")),
            "node '/Users/c/code (old)/palimpsest/bin/palimpsest.mjs' engine install"
        );
    }

    #[test]
    fn the_baked_repo_path_has_no_parent_step() {
        assert!(!repo().display().to_string().contains(".."));
        assert!(repo().join("bin").join("palimpsest.mjs").is_file());
    }

    #[test]
    fn other_failures_keep_the_commands_words() {
        assert_eq!(
            classify_install(false, "  launchctl bootstrap failed: 5: Input/output error\n", "exit status: 1", "Downloads"),
            Err(InstallError::Failed { message: "launchctl bootstrap failed: 5: Input/output error".into() })
        );
        assert_eq!(
            classify_install(false, "Error: EACCES: permission denied, open 'x'", "exit status: 1", "Downloads"),
            Err(InstallError::Failed { message: "Error: EACCES: permission denied, open 'x'".into() })
        );
    }

    #[test]
    fn silent_failure_reports_the_exit_status() {
        assert_eq!(
            classify_install(false, "", "exit status: 3", "Downloads"),
            Err(InstallError::Failed { message: "The install exited with exit status: 3.".into() })
        );
    }

    #[test]
    fn eperm_io_errors_are_told_apart_from_eacces() {
        assert!(io_not_permitted(&std::io::Error::from_raw_os_error(1)));
        assert!(!io_not_permitted(&std::io::Error::from_raw_os_error(13)));
        assert!(!io_not_permitted(&std::io::Error::from(std::io::ErrorKind::NotFound)));
    }

    #[test]
    fn the_protected_folder_is_named_as_settings_names_it() {
        let home = Path::new("/Users/c");
        assert_eq!(protected_folder(Path::new("/Users/c/Downloads/palimpsest"), home), "Downloads");
        assert_eq!(protected_folder(Path::new("/Users/c/Documents/code/palimpsest"), home), "Documents");
        assert_eq!(protected_folder(Path::new("/Users/c/Desktop/palimpsest"), home), "Desktop");
        assert_eq!(protected_folder(Path::new("/Volumes/Work/palimpsest"), home), "/Volumes/Work");
        assert_eq!(protected_folder(Path::new("/Users/c/DownloadsOld/palimpsest"), home), "/Users/c/DownloadsOld");
    }
}
