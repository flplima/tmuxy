//! What `ps` and `lsof` print, read: the process table where there is no
//! `/proc`. Parsed apart from running them, so the parsing is tested on
//! every machine.

use std::collections::HashMap;

/// `ps -o pid=,ppid=`: two numbers a line.
pub(crate) fn parse_ps(out: &str) -> HashMap<u32, u32> {
    out.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
        })
        .collect()
}

/// `lsof -Fpn`: a `p<pid>` line, then an `n<address>:<port>` line for each
/// socket it holds.
pub(crate) fn parse_lsof(out: &str) -> HashMap<u32, Vec<u16>> {
    let mut listening: HashMap<u32, Vec<u16>> = HashMap::new();
    let mut pid = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().ok();
        } else if let (Some(name), Some(pid)) = (line.strip_prefix('n'), pid) {
            if let Some(port) = name.rsplit_once(':').and_then(|(_, p)| p.parse().ok()) {
                let ports = listening.entry(pid).or_default();
                if !ports.contains(&port) {
                    ports.push(port);
                }
            }
        }
    }
    listening
}
