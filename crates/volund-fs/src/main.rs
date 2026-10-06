use encoding_rs::{Encoding, UTF_8};
use serde_json::{json, Value};
use similar::{Algorithm, TextDiff};
use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};
use tiktoken_rs::{cl100k_base, get_bpe_from_model, CoreBPE};

const MAX_READ_BYTES: u64 = 100 * 1024 * 1024;

fn string_param<'a>(params: &'a Value, name: &str) -> Result<&'a str, String> {
    params
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string parameter: {name}"))
}

fn unified_diff(before: &str, after: &str, context: usize) -> String {
    if before == after {
        return String::new();
    }
    TextDiff::configure()
        .algorithm(Algorithm::Patience)
        .diff_lines(before, after)
        .unified_diff()
        .context_radius(context)
        .header("before", "after")
        .to_string()
}

// Building a BPE costs tens of milliseconds; cache one tokenizer per model
// (the cl100k fallback cached under the requested name once it is used).
fn bpe_for(model: &str) -> Result<Arc<CoreBPE>, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<CoreBPE>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().map_err(|_| "tokenizer cache poisoned")?;
    if let Some(bpe) = guard.get(model) {
        return Ok(Arc::clone(bpe));
    }
    let bpe = Arc::new(
        get_bpe_from_model(model)
            .or_else(|_| cl100k_base())
            .map_err(|e| e.to_string())?,
    );
    guard.insert(model.to_owned(), Arc::clone(&bpe));
    Ok(bpe)
}

fn count_tokens(text: &str, model: &str) -> Result<usize, String> {
    let bpe = bpe_for(model)?;
    Ok(bpe.encode_with_special_tokens(text).len())
}

/// Byte-range read: `offset`/`limit` (bytes) select a window of the file; the
/// limit is enforced on the range, and a range boundary may split a multibyte
/// character (callers align ranges).
fn read_large(
    path: &Path,
    label: Option<&str>,
    max_bytes: u64,
    offset: u64,
    limit: Option<u64>,
) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    if offset > file_len {
        return Ok(String::new());
    }
    let requested = limit.unwrap_or(u64::MAX).min(file_len - offset);
    if requested > max_bytes {
        return Err(format!("read range exceeds limit of {max_bytes} bytes"));
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![0_u8; requested as usize];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Err("binary file is not supported".into());
    }
    let encoding = label
        .and_then(|v| Encoding::for_label(v.as_bytes()))
        .unwrap_or(UTF_8);
    let (text, _, malformed) = encoding.decode(&bytes);
    if malformed {
        return Err(format!("input is not valid {}", encoding.name()));
    }
    Ok(text.into_owned())
}

fn dispatch(request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let params = request.get("params").unwrap_or(&Value::Null);
    let result: Result<Value, String> = match request.get("method").and_then(Value::as_str) {
        Some("fs.diff") => (|| {
            Ok(json!(unified_diff(
                string_param(params, "before")?,
                string_param(params, "after")?,
                params.get("context").and_then(Value::as_u64).unwrap_or(3) as usize
            )))
        })(),
        Some("fs.count_tokens") => (|| {
            Ok(json!(count_tokens(
                string_param(params, "text")?,
                string_param(params, "model")?
            )?))
        })(),
        Some("fs.read_large") => (|| {
            Ok(json!(read_large(
                Path::new(string_param(params, "path")?),
                params.get("encoding").and_then(Value::as_str),
                params
                    .get("maxBytes")
                    .and_then(Value::as_u64)
                    .unwrap_or(MAX_READ_BYTES),
                params.get("offset").and_then(Value::as_u64).unwrap_or(0),
                params.get("limit").and_then(Value::as_u64),
            )?))
        })(),
        _ => {
            return json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}})
        }
    };
    match result {
        Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
        Err(message) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}}),
    }
}

fn main() {
    println!(
        "{}",
        json!({"jsonrpc":"2.0","method":"worker.ready","params":{"protocol":1,"kind":"fs"}})
    );
    io::stdout().flush().ok();
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        if let Ok(request) = serde_json::from_str::<Value>(&line) {
            println!("{}", dispatch(&request));
            io::stdout().flush().ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patience_diff_has_real_hunks() {
        let d = unified_diff("a\nb\nc\n", "a\nx\nc\n", 1);
        assert!(d.contains("@@ -1,3 +1,3 @@"));
        assert!(d.contains("-b\n+x"));
    }
    #[test]
    fn tokenizer_is_bpe_not_whitespace() {
        assert_eq!(count_tokens("hello world", "gpt-4o").unwrap(), 2);
        assert!(count_tokens("hello-world", "gpt-4o").unwrap() > 1);
    }
    #[test]
    fn tokenizer_cache_reuses_one_bpe_per_model() {
        let first = bpe_for("gpt-4o").unwrap();
        let second = bpe_for("gpt-4o").unwrap();
        assert!(Arc::ptr_eq(&first, &second));
    }
    #[test]
    fn read_large_supports_byte_ranges() {
        let path = std::env::temp_dir().join(format!(
            "volund-fs-range-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, b"hello volund range").unwrap();
        assert_eq!(
            read_large(&path, None, MAX_READ_BYTES, 6, Some(6)).unwrap(),
            "volund"
        );
        assert_eq!(
            read_large(&path, None, MAX_READ_BYTES, 999, None).unwrap(),
            ""
        );
        assert!(read_large(&path, None, 4, 0, None)
            .unwrap_err()
            .contains("read range exceeds limit"));
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn unknown_method_is_rejected() {
        assert_eq!(
            dispatch(&json!({"id":1,"method":"other"}))["error"]["code"],
            -32601
        );
    }
}
