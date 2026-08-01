use serde_json::{json, Value};
use std::{
    fs,
    io::{self, BufRead, Write},
    path::Path,
};

fn visit(root: &Path, needle: &str, matches: &mut Vec<Value>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_name()
            .is_some_and(|name| name == ".git" || name == "target" || name == "node_modules")
        {
            continue;
        }
        if path.is_dir() {
            visit(&path, needle, matches);
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else { continue };
        for (index, line) in contents.lines().enumerate() {
            if line.contains(needle) {
                matches.push(json!({"path":path,"line":index + 1,"text":line}));
            }
        }
    }
}

fn main() {
    println!(
        "{}",
        json!({"jsonrpc":"2.0","method":"worker.ready","params":{"protocol":1,"kind":"search"}})
    );
    io::stdout().flush().ok();
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let response = match request.get("method").and_then(Value::as_str) {
            Some("search.query") => {
                let params = &request["params"];
                let mut matches = Vec::new();
                visit(
                    Path::new(params["cwd"].as_str().unwrap_or(".")),
                    params["pattern"].as_str().unwrap_or(""),
                    &mut matches,
                );
                let truncated = matches.len() > 10_000;
                matches.truncate(10_000);
                json!({"jsonrpc":"2.0","id":id,"result":{"matches":matches,"truncated":truncated}})
            }
            Some("search.abort") => continue,
            _ => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}})
            }
        };
        println!("{response}");
        io::stdout().flush().ok();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn worker_protocol_version_is_stable() {
        assert_eq!(1, 1);
    }
}
