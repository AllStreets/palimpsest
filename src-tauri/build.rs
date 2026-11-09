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
    tauri_build::build()
}
