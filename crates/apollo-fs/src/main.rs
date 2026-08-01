use serde_json::{json, Value};
use std::{
    fs,
    io::{self, BufRead, Write},
};

fn dispatch(request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let params = request.get("params").unwrap_or(&Value::Null);
    let result = match request.get("method").and_then(Value::as_str) {
        Some("fs.diff") => Ok(json!(simple_diff(
            params["before"].as_str().unwrap_or(""),
            params["after"].as_str().unwrap_or("")
        ))),
        Some("fs.count_tokens") => Ok(json!(params["text"]
            .as_str()
            .unwrap_or("")
            .split_whitespace()
            .count())),
        Some("fs.read_large") => fs::read_to_string(params["path"].as_str().unwrap_or(""))
            .map(Value::String)
            .map_err(|e| e.to_string()),
        _ => {
            return json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}})
        }
    };
    match result {
        Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
        Err(message) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}}),
    }
}

fn simple_diff(before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    format!(
        "--- before\n+++ after\n@@\n-{}\n+{}\n",
        before.replace('\n', "\n-"),
        after.replace('\n', "\n+")
    )
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
    fn diff_is_empty_for_equal_input() {
        assert_eq!(simple_diff("a", "a"), "");
    }
    #[test]
    fn unknown_method_is_rejected() {
        assert_eq!(
            dispatch(&json!({"id":1,"method":"other"}))["error"]["code"],
            -32601
        );
    }
}
