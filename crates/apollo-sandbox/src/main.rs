use apollo_sandbox::{probe, run, ExecRequest};
use std::io::Read;
fn main() {
    let probe_mode = std::env::args().any(|arg| arg == "--probe");
    if probe_mode {
        println!(
            "{}",
            serde_json::to_string(&probe()).expect("serialize probe")
        );
        return;
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
