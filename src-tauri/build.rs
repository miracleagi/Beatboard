fn main() {
    // Tauri validates externalBin entries even for `cargo check`. Keep source
    // development lightweight with a generated PATH-forwarding shim, but never
    // allow that shim into a release build: releases must run the reproducible
    // FFmpeg build script first.
    let target = std::env::var("TARGET").expect("Cargo did not provide TARGET");
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let sidecar = std::path::PathBuf::from("binaries").join(format!("ffmpeg-{target}"));
    let is_macho = std::fs::read(&sidecar)
        .ok()
        .and_then(|bytes| {
            bytes
                .get(..4)
                .map(|magic| magic == [0xcf, 0xfa, 0xed, 0xfe])
        })
        .unwrap_or(false);
    if profile == "release" && !is_macho {
        panic!(
            "missing real bundled ffmpeg sidecar {}; run ../scripts/build-bundled-ffmpeg.sh first",
            sidecar.display()
        );
    }
    if !sidecar.exists() {
        std::fs::create_dir_all("binaries").expect("failed to create sidecar directory");
        std::fs::write(&sidecar, b"#!/bin/sh\nexec ffmpeg \"$@\"\n")
            .expect("failed to create development ffmpeg shim");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&sidecar).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&sidecar, permissions).unwrap();
        }
    }
    tauri_build::build()
}
