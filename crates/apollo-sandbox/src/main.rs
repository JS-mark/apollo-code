use apollo_sandbox::{bundled_bwrap, digest::verify_sha256, probe, run, ExecRequest};
use std::io::Read;
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let probe_mode = args.iter().any(|arg| arg == "--probe");
    if probe_mode {
        println!(
            "{}",
            serde_json::to_string(&probe()).expect("serialize probe")
        );
        return;
    }
    if args.first().map(String::as_str) == Some("--verify-bwrap-digest") {
        let verification = if args.len() == 1 {
            bundled_bwrap::verify_embedded()
        } else if args.len() == 3 {
            verify_sha256(std::path::Path::new(&args[1]), &args[2])
        } else {
            Err("usage: apollo-sandbox --verify-bwrap-digest [path sha256]".into())
        };
        match verification {
            Ok(()) => {
                println!("{{\"verified\":true}}");
                return;
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
    }
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("read stdin");
    let result = serde_json::from_str::<ExecRequest>(&input)
        .map_err(|e| format!("invalid request: {e}"))
        .and_then(|r| run(&r));
    match result {
        Ok(value) => println!(
            "{}",
            serde_json::to_string(&value).expect("serialize result")
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}
