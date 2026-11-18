use std::process::Command;

fn main() {
    // The app runs from Finder with launchd's bare PATH, where an nvm or Homebrew node is not
    // found. Bake in the node that built the app; main.rs falls back to a search if it moves.
    println!("cargo:rerun-if-env-changed=PATH");
    let node = Command::new("/bin/sh")
        .args(["-c", "command -v node"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=PALIMPSEST_BUILD_NODE={node}");
    // Naming the app's commands turns on Tauri's access control for them: capabilities/ says which
    // page may call which. The splash (local) calls the engine commands; the city, served by the
    // engine over http://127.0.0.1:4770, may call open_external and nothing else.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "engine_healthy",
        "open_city",
        "install_engine",
        "open_folder_access",
        "engine_command",
        "open_external",
    ])))
    .expect("failed to run the Tauri build script")
}
