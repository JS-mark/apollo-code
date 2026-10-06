use globset::GlobMatcher;
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, BufRead, Write},
    path::Path,
};
use tree_sitter::{Language, Parser, Query, QueryCursor};

const HARD_LIMIT: usize = 10_000;

fn language(name: &str) -> Result<Language, String> {
    match name {
        "javascript" | "js" => Ok(tree_sitter_javascript::language()),
        "typescript" | "ts" => Ok(tree_sitter_typescript::language_typescript()),
        "tsx" => Ok(tree_sitter_typescript::language_tsx()),
        "python" | "py" => Ok(tree_sitter_python::language()),
        "rust" | "rs" => Ok(tree_sitter_rust::language()),
        _ => Err(format!("unsupported AST language: {name}")),
    }
}

/// File extensions an AST language should be applied to — without this filter
/// every .md/.json file in the tree would be handed to tree-sitter.
fn extensions_for(name: &str) -> &'static [&'static str] {
    match name {
        "javascript" | "js" => &["js", "jsx", "mjs", "cjs"],
        "typescript" | "ts" => &["ts", "mts", "cts"],
        "tsx" => &["tsx"],
        "python" | "py" => &["py", "pyi"],
        "rust" | "rs" => &["rs"],
        _ => &[],
    }
}

fn glob_matcher(pattern: &str) -> Result<GlobMatcher, String> {
    use globset::GlobBuilder;
    Ok(GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|e| format!("invalid glob pattern: {e}"))?
        .compile_matcher())
}

/// Path of `file` relative to `root`, `/`-separated, for glob matching.
fn relative_path(root: &Path, file: &Path) -> String {
    file.strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
}

fn walk_files(root: &Path, extra_ignores: &[String]) -> ignore::Walk {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .add_custom_ignore_filename(".volundignore");
    if !extra_ignores.is_empty() {
        let mut overrides = ignore::overrides::OverrideBuilder::new(root);
        for pattern in extra_ignores {
            let _ = overrides.add(&format!("!{pattern}"));
        }
        if let Ok(value) = overrides.build() {
            builder.overrides(value);
        }
    }
    builder.build()
}

fn search(params: &Value) -> Result<(Vec<Value>, bool), String> {
    let root = params
        .get("path")
        .or_else(|| params.get("cwd"))
        .and_then(Value::as_str)
        .unwrap_or(".");
    let pattern = params
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or("missing string parameter: pattern")?;
    let regex = RegexBuilder::new(pattern)
        .case_insensitive(
            params
                .get("caseInsensitive")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )
        .build()
        .map_err(|e| e.to_string())?;
    let limit = params
        .get("maxMatches")
        .and_then(Value::as_u64)
        .unwrap_or(HARD_LIMIT as u64)
        .min(HARD_LIMIT as u64) as usize;
    let ignores: Vec<String> = params
        .get("ignore")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    // Optional include-glob (dialect contract with the JS fallback's fast-glob).
    let glob = match params.get("glob").and_then(Value::as_str) {
        Some(pattern) => Some(glob_matcher(pattern)?),
        None => None,
    };
    let root_path = Path::new(root);
    let mut output = Vec::new();
    let mut truncated = false;
    'files: for entry in walk_files(root_path, &ignores)
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
    {
        if let Some(matcher) = &glob {
            if !matcher.is_match(relative_path(root_path, entry.path())) {
                continue;
            }
        }
        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        if bytes.iter().take(8192).any(|b| *b == 0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        // Byte offsets must count the raw line including a trailing \r, while
        // matching runs on the stripped line (CRLF files would drift).
        let mut offset = 0;
        for (line_index, raw_line) in text.split('\n').enumerate() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            for found in regex.find_iter(line) {
                if output.len() >= limit {
                    truncated = true;
                    break 'files;
                }
                output.push(json!({"path":entry.path(),"lineNumber":line_index+1,"line":line,"span":{"start":offset+found.start(),"end":offset+found.end()}}));
            }
            offset += raw_line.len() + 1;
        }
    }
    Ok((output, truncated))
}

fn ast_query(params: &Value) -> Result<(Vec<Value>, bool), String> {
    let root = params
        .get("path")
        .or_else(|| params.get("cwd"))
        .and_then(Value::as_str)
        .unwrap_or(".");
    let lang = language(
        params
            .get("language")
            .and_then(Value::as_str)
            .ok_or("missing string parameter: language")?,
    )?;
    let extensions = extensions_for(
        params
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let ignores: Vec<String> = params
        .get("ignore")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let query_text = params
        .get("query")
        .and_then(Value::as_str)
        .ok_or("missing string parameter: query")?;
    let query = Query::new(&lang, query_text).map_err(|e| format!("invalid AST query: {e}"))?;
    let limit = params
        .get("maxMatches")
        .and_then(Value::as_u64)
        .unwrap_or(HARD_LIMIT as u64)
        .min(HARD_LIMIT as u64) as usize;
    let mut parser = Parser::new();
    parser.set_language(&lang).map_err(|e| e.to_string())?;
    let root_path = Path::new(root);
    let mut output = Vec::new();
    let mut truncated = false;
    'files: for entry in walk_files(root_path, &ignores)
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| extensions.contains(&ext))
        })
    {
        let Ok(source) = fs::read(entry.path()) else {
            continue;
        };
        let Some(tree) = parser.parse(&source, None) else {
            continue;
        };
        let mut cursor = QueryCursor::new();
        for matched in cursor.matches(&query, tree.root_node(), source.as_slice()) {
            for capture in matched.captures {
                if output.len() >= limit {
                    truncated = true;
                    break 'files;
                }
                let node = capture.node;
                let start = node.start_position();
                let end = node.end_position();
                output.push(json!({"path":entry.path(),"capture":query.capture_names()[capture.index as usize],"text":String::from_utf8_lossy(&source[node.byte_range()]),"span":{"start":node.start_byte(),"end":node.end_byte()},"start":{"line":start.row+1,"column":start.column},"end":{"line":end.row+1,"column":end.column}}));
            }
        }
    }
    Ok((output, truncated))
}

fn glob_files(params: &Value) -> Result<(Vec<Value>, bool), String> {
    let root = params
        .get("path")
        .or_else(|| params.get("cwd"))
        .and_then(Value::as_str)
        .unwrap_or(".");
    let pattern = params
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or("missing string parameter: pattern")?;
    let matcher = glob_matcher(pattern)?;
    let limit = params
        .get("maxMatches")
        .and_then(Value::as_u64)
        .unwrap_or(HARD_LIMIT as u64)
        .min(HARD_LIMIT as u64) as usize;
    let ignores: Vec<String> = params
        .get("ignore")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let root_path = Path::new(root);
    let mut output = Vec::new();
    let mut truncated = false;
    for entry in walk_files(root_path, &ignores)
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
    {
        if output.len() >= limit {
            truncated = true;
            break;
        }
        let relative = relative_path(root_path, entry.path());
        if matcher.is_match(&relative) {
            output.push(json!(relative));
        }
    }
    Ok((output, truncated))
}

fn main() {
    println!(
        "{}",
        json!({"jsonrpc":"2.0","method":"worker.ready","params":{"protocol":1,"kind":"search"}})
    );
    io::stdout().flush().ok();
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str);
        let params = &request["params"];
        let result = match method {
            Some("search.query") => search(params),
            Some("search.ast_query") => ast_query(params),
            Some("search.glob_files") => glob_files(params),
            Some("search.abort") => continue,
            _ => {
                println!(
                    "{}",
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}})
                );
                io::stdout().flush().ok();
                continue;
            }
        };
        match result {
            Ok((matches, truncated)) => println!(
                "{}",
                json!({"jsonrpc":"2.0","id":id,"result":{"matches":matches,"truncated":truncated}})
            ),
            Err(message) => println!(
                "{}",
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}})
            ),
        }
        io::stdout().flush().ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_tree(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "volund-search-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "const a = 1;\n").unwrap();
        fs::write(root.join("src/b.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("README.md"), "# doc\n").unwrap();
        fs::write(root.join("crlf.txt"), "first\r\nsecond\r\n").unwrap();
        root
    }

    #[test]
    fn languages_are_explicit() {
        assert!(language("typescript").is_ok());
        assert!(language("unknown").unwrap_err().contains("unsupported"));
    }
    #[test]
    fn invalid_regex_is_error() {
        assert!(search(&json!({"pattern":"[","path":"."})).is_err());
    }
    #[test]
    fn invalid_glob_is_error() {
        assert!(search(&json!({"pattern":"x","path":".","glob":"["})).is_err());
    }
    #[test]
    fn glob_filter_narrows_searched_files() {
        let root = temp_tree("glob");
        let everywhere = search(&json!({"pattern":"fn main","path":root})).unwrap().0;
        assert_eq!(everywhere.len(), 1);
        let rs_only = search(&json!({"pattern":"fn main","path":root,"glob":"**/*.rs"}))
            .unwrap()
            .0;
        assert_eq!(rs_only.len(), 1);
        let md_only = search(&json!({"pattern":"doc","path":root,"glob":"**/*.md"}))
            .unwrap()
            .0;
        assert_eq!(md_only.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crlf_files_report_undrifted_byte_offsets() {
        let root = temp_tree("crlf");
        let (matches, _) = search(&json!({"pattern":"second","path":root})).unwrap();
        assert_eq!(matches.len(), 1);
        let span = matches[0]["span"].clone();
        let text = fs::read_to_string(root.join("crlf.txt")).unwrap();
        assert_eq!(
            &text[span["start"].as_u64().unwrap() as usize..span["end"].as_u64().unwrap() as usize],
            "second"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ast_query_skips_files_outside_the_language_extensions() {
        let root = temp_tree("ast");
        let (matches, _) = ast_query(&json!({
            "language": "typescript",
            "query": "(variable_declarator name: (identifier) @name)",
            "path": root,
        }))
        .unwrap();
        assert!(!matches.is_empty());
        assert!(matches
            .iter()
            .all(|m| { m["path"].as_str().unwrap().ends_with(".ts") }));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn glob_files_lists_gitignored_aware_relative_paths() {
        let root = temp_tree("files");
        // gitignore semantics require a repository (ignore crate defaults).
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .expect("git init")
            .success());
        fs::write(root.join(".gitignore"), "src/b.rs\n").unwrap();
        let (all, truncated) = glob_files(&json!({"pattern":"**/*","path":root})).unwrap();
        assert!(!truncated);
        let paths: Vec<&str> = all.iter().filter_map(|v| v.as_str()).collect();
        assert!(paths.contains(&"src/a.ts"));
        assert!(paths.contains(&"README.md"));
        assert!(!paths.contains(&"src/b.rs"), "gitignore must be honored");
        let (ts_only, _) = glob_files(&json!({"pattern":"**/*.ts","path":root})).unwrap();
        assert_eq!(ts_only, vec![json!("src/a.ts")]);
        fs::remove_dir_all(root).unwrap();
    }
}
