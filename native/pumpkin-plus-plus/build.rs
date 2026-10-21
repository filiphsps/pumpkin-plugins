//! Derive handshake provenance from the locked upstream package, never the API integer.
use std::{env, fs, path::PathBuf};

fn field<'a>(section: &'a str, key: &str) -> &'a str {
    let prefix = format!("{key} = \"");
    section
        .lines()
        .find_map(|line| line.strip_prefix(&prefix)?.strip_suffix('"'))
        .unwrap_or_else(|| panic!("Missing {key} in locked Pumpkin package"))
}
fn main() {
    let lock = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"))
        .join("Cargo.lock");
    let text = fs::read_to_string(&lock).expect("read committed Cargo.lock");
    let package = text
        .split("[[package]]")
        .find(|section| section.lines().any(|line| line == "name = \"pumpkin\""))
        .expect("locked upstream Pumpkin package");
    let release = field(package, "version");
    let source = field(package, "source");
    let sha = source
        .rsplit_once('#')
        .expect("immutable upstream git source")
        .1;
    assert!(
        sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()),
        "full upstream git SHA required"
    );
    println!("cargo:rerun-if-changed={}", lock.display());
    println!("cargo:rustc-env=PUMPKIN_HOST_RELEASE={release}");
    println!("cargo:rustc-env=PUMPKIN_HOST_SOURCE_COMMIT={sha}");
}
