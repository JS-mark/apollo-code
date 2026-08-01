use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("expected digest must be exactly 64 hexadecimal characters".into());
    }
    let actual = sha256_file(path)?;
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "SHA256 mismatch for {}: expected {expected}, got {actual}",
            path.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn rejects_tampered_bwrap_payload() {
        let path = std::env::temp_dir().join(format!(
            "apollo-bwrap-digest-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, b"known bundled bwrap").unwrap();
        let expected = sha256_file(&path).unwrap();
        verify_sha256(&path, &expected).unwrap();
        fs::write(&path, b"tampered bundled bwrap").unwrap();
        assert!(verify_sha256(&path, &expected)
            .unwrap_err()
            .contains("SHA256 mismatch"));
        fs::remove_file(path).unwrap();
    }
}
