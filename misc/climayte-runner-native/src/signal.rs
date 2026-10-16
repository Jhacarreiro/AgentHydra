//! The worker's wind-down hook, answered by its runner (what `serveSignal` and `pointSignalHook` in
//! server/src/climayte-signal.ts do for the Bun runner).
//!
//! The daemon writes the worker's signal file; the CLI shows it to the model through a PostToolUse
//! hook that runs after EVERY tool call. As an `http` hook that costs the CLI one POST to 127.0.0.1
//! and starts nothing, and an unreachable hook is a non-blocking error. The runner answers it
//! because it lives exactly as long as the worker: a daemon restart or stall cannot strand or slow
//! a running worker's hook. Before the CLI starts, the runner rewrites the settings file the daemon
//! wrote so the hook points here; until then, and if either step fails, the settings keep the
//! daemon's `cat` form, which costs more processes and loses nothing.

use crate::json::{self, Json};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The CLI's stdin while it runs, taken (and so closed) by the runner when the turn's result shows.
pub type Sink = Arc<Mutex<Option<Box<dyn Write + Send>>>>;

/// The `/deliver` route: a message the daemon writes into the running CLI's stdin mid-turn.
pub struct Deliver {
    pub token: String,
    pub sink: Sink,
    /// One line per accepted message: `{"requestId":...}`.
    pub delivered: PathBuf,
}

struct Hub {
    signal_file: PathBuf,
    deliver: Option<Deliver>,
}

const TOKEN_HEADER: &str = "x-climayte-deliver-token";

/// Longest a tool call waits on the hook (SIGNAL_HOOK_TIMEOUT_S in climayte-signal.ts).
const HOOK_TIMEOUT_S: u32 = 3;
/// A request head larger than this is not the CLI's hook.
const MAX_HEAD: usize = 64 * 1024;
/// A hook input carries the tool's input and result, so it can be large; past this the connection
/// is dropped, which the CLI treats as a non-blocking hook error.
const MAX_BODY: usize = 64 * 1024 * 1024;
/// A client that stops sending is dropped after this, freeing its thread.
const IO_TIMEOUT: Duration = Duration::from_secs(10);

/// Binds a loopback port, points the worker's settings at it, then answers on a thread for as long
/// as this process lives. The port, or None with no port held and the settings untouched, when a
/// step fails.
pub fn serve(signal_file: PathBuf, settings_file: &Path, deliver: Option<Deliver>) -> Option<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    if !point_hook(settings_file, port) {
        return None;
    }
    let hub = Arc::new(Hub {
        signal_file,
        deliver,
    });
    let accept = move || {
        for conn in listener.incoming().flatten() {
            let hub = Arc::clone(&hub);
            // A thread per call: tool calls run in parallel, and one slow client must not hold up
            // the rest. When no thread can be had the connection is dropped, which the CLI treats
            // as a non-blocking hook error.
            let _ = std::thread::Builder::new().spawn(move || answer(conn, &hub));
        }
    };
    std::thread::Builder::new()
        .spawn(accept)
        .ok()
        .map(|_| port)
}

/// Rewrites the worker's settings so its PostToolUse hook is an http hook at this port, keeping
/// every other key in its place. False, with the file untouched, when it cannot be read or parsed.
pub fn point_hook(settings_file: &Path, port: u16) -> bool {
    let Some(mut settings) = std::fs::read_to_string(settings_file)
        .ok()
        .and_then(|t| json::parse(&t))
    else {
        return false;
    };
    let hook = Json::obj(vec![
        ("matcher", Json::str("*")),
        (
            "hooks",
            Json::Arr(vec![Json::obj(vec![
                ("type", Json::str("http")),
                ("url", Json::str(format!("http://127.0.0.1:{port}/signal"))),
                ("timeout", Json::num(HOOK_TIMEOUT_S)),
            ])]),
        ),
    ]);
    let mut hooks = match settings.get("hooks") {
        Some(h @ Json::Obj(_)) => h.clone(),
        _ => Json::Obj(Vec::new()),
    };
    hooks.set("PostToolUse", Json::Arr(vec![hook]));
    settings.set("hooks", hooks)
        && std::fs::write(settings_file, json::to_string(&settings)).is_ok()
}

struct Request {
    path: String,
    /// Names lowercased, values trimmed.
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

fn answer(mut conn: TcpStream, hub: &Hub) {
    let _ = conn.set_read_timeout(Some(IO_TIMEOUT));
    let _ = conn.set_write_timeout(Some(IO_TIMEOUT));
    let Some(req) = read_request(&mut conn) else {
        return;
    };
    let (status, body) = respond(&req, hub);
    let head = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = conn
        .write_all(head.as_bytes())
        .and_then(|_| conn.write_all(body.as_bytes()));
    let _ = conn.flush();
    let _ = conn.shutdown(Shutdown::Write);
}

fn respond(req: &Request, hub: &Hub) -> (&'static str, String) {
    if let Some(reason) = refused(req) {
        return (
            "403 Forbidden",
            format!("{{\"error\":\"forbidden: {reason}\"}}"),
        );
    }
    if req.path == "/deliver" {
        return deliver(req, hub.deliver.as_ref());
    }
    // A tool call inside one of the worker's sub-agents always gets `{}`: the handoff is the
    // worker's to write, and a sub-agent told to write it quits mid-task and overwrites the
    // worker's own (2026-10-04). The CLI sends `agent_id` only inside a sub-agent.
    if from_subagent(&req.body) {
        return ("200 OK", "{}".into());
    }
    // Read afresh each time, so the signal shows on every call from the moment it is written until
    // the file is removed. No file, or one caught half written: nothing to say.
    let body = std::fs::read(&hub.signal_file)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .filter(|t| json::parse(t).is_some())
        .unwrap_or_else(|| "{}".into());
    ("200 OK", body)
}

/// Writes the message into the CLI's stdin as one stream-json user line, then records its request
/// id. 409 when the CLI's stdin is closed (its turn has ended, or the write failed): the daemon then
/// holds the message for the next turn instead.
fn deliver(req: &Request, route: Option<&Deliver>) -> (&'static str, String) {
    let Some(route) = route else {
        return ("404 Not Found", "{\"error\":\"no delivery route\"}".into());
    };
    if req.header(TOKEN_HEADER) != Some(route.token.as_str()) {
        return ("403 Forbidden", "{\"error\":\"forbidden: bad token\"}".into());
    }
    let input = std::str::from_utf8(&req.body).ok().and_then(json::parse);
    let text = input
        .as_ref()
        .and_then(|i| i.get("text"))
        .and_then(Json::as_str);
    let request_id = input
        .as_ref()
        .and_then(|i| i.get("requestId"))
        .and_then(Json::as_str);
    let (Some(text), Some(request_id)) = (text, request_id) else {
        return ("400 Bad Request", "{\"error\":\"text and requestId required\"}".into());
    };
    let line = format!("{}\n", json::to_string(&user_line(text)));
    let mut slot = route.sink.lock().unwrap_or_else(|e| e.into_inner());
    let Some(stdin) = slot.as_mut() else {
        return ("409 Conflict", "{\"error\":\"stdin closed\"}".into());
    };
    if stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.flush())
        .is_err()
    {
        *slot = None;
        return ("409 Conflict", "{\"error\":\"stdin closed\"}".into());
    }
    record(&route.delivered, request_id);
    ("200 OK", "{\"ok\":true}".into())
}

fn user_line(text: &str) -> Json {
    Json::obj(vec![
        ("type", Json::str("user")),
        (
            "message",
            Json::obj(vec![
                ("role", Json::str("user")),
                (
                    "content",
                    Json::Arr(vec![Json::obj(vec![
                        ("type", Json::str("text")),
                        ("text", Json::str(text)),
                    ])]),
                ),
            ]),
        ),
    ])
}

fn record(path: &Path, request_id: &str) {
    let line = json::to_string(&Json::obj(vec![("requestId", Json::str(request_id))]));
    if let Ok(mut file) = OpenOptions::new().append(true).create(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn from_subagent(body: &[u8]) -> bool {
    std::str::from_utf8(body)
        .ok()
        .and_then(json::parse)
        .and_then(|input| {
            input
                .get("agent_id")
                .and_then(Json::as_str)
                .map(|id| !id.trim().is_empty())
        })
        .unwrap_or(false)
}

/// The guard every AgentHydra loopback server runs (server/src/loopback-guard.mjs), in its
/// exact-origin mode with an empty allowlist: a web page on any local port carries an Origin and is
/// refused, as is a browser's cross-site request or a rebinding Host. The CLI's hook sends none.
fn refused(req: &Request) -> Option<&'static str> {
    if req
        .header("sec-fetch-site")
        .is_some_and(|v| v.eq_ignore_ascii_case("cross-site"))
    {
        return Some("cross-site request rejected");
    }
    if req.header("origin").is_some_and(|v| !v.is_empty()) {
        return Some("origin not in allowlist");
    }
    if req
        .header("host")
        .is_some_and(|v| !v.is_empty() && !is_loopback_host(v))
    {
        return Some("non-loopback Host rejected");
    }
    None
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else {
        host.rsplit_once(':').map_or(host.as_str(), |(h, _)| h)
    };
    matches!(name, "127.0.0.1" | "localhost" | "::1")
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Reads more into `buf`; None at the end of the stream or on an error.
fn more(conn: &mut TcpStream, buf: &mut Vec<u8>) -> Option<()> {
    let mut chunk = [0u8; 16 * 1024];
    let n = conn.read(&mut chunk).ok()?;
    if n == 0 {
        return None;
    }
    buf.extend_from_slice(&chunk[..n]);
    Some(())
}

/// One whole request, its body read to the end: closing a socket with unread input resets it, and
/// the CLI would see its call fail.
fn read_request(conn: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let head_end = loop {
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
        more(conn, &mut buf)?;
    };
    let head = std::str::from_utf8(&buf[..head_end]).ok()?;
    let headers: Vec<(String, String)> = head
        .split("\r\n")
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let path = head
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    let req = Request {
        path,
        headers,
        body: Vec::new(),
    };
    let rest = buf[head_end + 4..].to_vec();
    if req
        .header("expect")
        .is_some_and(|v| v.eq_ignore_ascii_case("100-continue"))
    {
        conn.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").ok()?;
    }
    let chunked = req
        .header("transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    let body = if chunked {
        read_chunked(conn, rest)?
    } else {
        let len: usize = match req.header("content-length") {
            Some(v) => v.parse().ok()?,
            None => 0,
        };
        if len > MAX_BODY {
            return None;
        }
        let mut body = rest;
        while body.len() < len {
            more(conn, &mut body)?;
        }
        body.truncate(len);
        body
    };
    Some(Request { body, ..req })
}

/// A chunked body (RFC 9112 section 7.1), decoded; trailers are read and ignored.
fn read_chunked(conn: &mut TcpStream, mut buf: Vec<u8>) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    let mut at = 0;
    loop {
        let line_end = line(conn, &mut buf, at)?;
        let size_text = std::str::from_utf8(&buf[at..line_end]).ok()?;
        let size_hex = size_text.split(';').next()?.trim();
        if size_hex.is_empty() || !size_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let size = usize::from_str_radix(size_hex, 16).ok()?;
        at = line_end + 2;
        if size == 0 {
            loop {
                let end = line(conn, &mut buf, at)?;
                let blank = end == at;
                at = end + 2;
                if blank {
                    return Some(body);
                }
            }
        }
        // The size is the client's to name, up to usize::MAX: compared without adding to it, so
        // it cannot wrap past the cap.
        if size > MAX_BODY - body.len() {
            return None;
        }
        while buf.len() < at + size + 2 {
            more(conn, &mut buf)?;
        }
        body.extend_from_slice(&buf[at..at + size]);
        at += size + 2;
    }
}

/// Where the next CRLF from `from` starts, reading more as needed.
fn line(conn: &mut TcpStream, buf: &mut Vec<u8>, from: usize) -> Option<usize> {
    loop {
        if let Some(i) = find(&buf[from..], b"\r\n") {
            return Some(from + i);
        }
        if buf.len() - from > MAX_HEAD {
            return None;
        }
        more(conn, buf)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts_are_told_apart_from_others_as_the_guard_does() {
        for ok in [
            "127.0.0.1:7787",
            "localhost",
            "LOCALHOST:1",
            "[::1]:80",
            "[::1]",
            " 127.0.0.1 ",
        ] {
            assert!(is_loopback_host(ok), "{ok}");
        }
        for bad in [
            "evil.com",
            "evil.com:7787",
            "127.0.0.2",
            "::1",
            "localhost.evil.com",
            "",
        ] {
            assert!(!is_loopback_host(bad), "{bad}");
        }
    }

    /// Any local process can reach the port, and a panic aborts the runner, which ends the job and
    /// the worker's CLI with it.
    #[test]
    fn a_chunk_size_past_the_cap_drops_the_request_instead_of_overflowing() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client
            .write_all(
                b"POST /signal HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nA\r\nffffffffffffffff\r\nX",
            )
            .unwrap();
        let (mut conn, _) = listener.accept().unwrap();
        assert!(read_request(&mut conn).is_none());
    }

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct Broken;

    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("climayte-signal-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hub(dir: &Path, sink: Option<Box<dyn Write + Send>>) -> (Hub, Shared) {
        let shared = Shared::default();
        let sink: Sink = Arc::new(Mutex::new(
            sink.or_else(|| Some(Box::new(shared.clone()) as Box<dyn Write + Send>)),
        ));
        let deliver = Deliver {
            token: "secret".into(),
            sink,
            delivered: dir.join("delivered.jsonl"),
        };
        let hub = Hub {
            signal_file: dir.join("signal.json"),
            deliver: Some(deliver),
        };
        (hub, shared)
    }

    fn post(token: Option<&str>, body: &str) -> Request {
        let mut headers = vec![("host".to_string(), "127.0.0.1:1".to_string())];
        if let Some(t) = token {
            headers.push((TOKEN_HEADER.to_string(), t.to_string()));
        }
        Request {
            path: "/deliver".into(),
            headers,
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn a_delivery_is_one_stream_json_user_line_and_its_request_id_is_recorded() {
        let dir = scratch("deliver-ok");
        let (hub, shared) = hub(&dir, None);
        let req = post(Some("secret"), r#"{"requestId":"r1","text":"hello \"you\""}"#);
        assert_eq!(respond(&req, &hub).0, "200 OK");
        let written = String::from_utf8(shared.0.lock().unwrap().clone()).unwrap();
        assert!(written.ends_with('\n'));
        let line = json::parse(written.trim_end()).unwrap();
        assert_eq!(line.get("type").and_then(Json::as_str), Some("user"));
        let message = line.get("message").unwrap();
        assert_eq!(message.get("role").and_then(Json::as_str), Some("user"));
        let Json::Arr(content) = message.get("content").unwrap() else {
            panic!("content is not an array");
        };
        assert_eq!(content[0].get("type").and_then(Json::as_str), Some("text"));
        assert_eq!(content[0].get("text").and_then(Json::as_str), Some("hello \"you\""));
        let recorded = std::fs::read_to_string(dir.join("delivered.jsonl")).unwrap();
        assert_eq!(recorded.trim_end(), r#"{"requestId":"r1"}"#);
    }

    #[test]
    fn a_missing_or_wrong_token_is_refused_and_nothing_reaches_stdin() {
        let dir = scratch("deliver-token");
        let (hub, shared) = hub(&dir, None);
        let body = r#"{"requestId":"r2","text":"sneaky"}"#;
        assert_eq!(respond(&post(Some("guess"), body), &hub).0, "403 Forbidden");
        assert_eq!(respond(&post(None, body), &hub).0, "403 Forbidden");
        assert!(shared.0.lock().unwrap().is_empty());
        assert!(!dir.join("delivered.jsonl").exists());
    }

    #[test]
    fn a_closed_stdin_answers_409() {
        let dir = scratch("deliver-closed");
        let (hub, _) = hub(&dir, None);
        *hub.deliver.as_ref().unwrap().sink.lock().unwrap() = None;
        let body = r#"{"requestId":"r3","text":"late"}"#;
        assert_eq!(respond(&post(Some("secret"), body), &hub).0, "409 Conflict");
        assert!(!dir.join("delivered.jsonl").exists());
    }

    #[test]
    fn a_failed_write_answers_409_and_closes_the_stdin() {
        let dir = scratch("deliver-broken");
        let (hub, _) = hub(&dir, Some(Box::new(Broken)));
        let body = r#"{"requestId":"r4","text":"into the pipe"}"#;
        assert_eq!(respond(&post(Some("secret"), body), &hub).0, "409 Conflict");
        let slot = hub.deliver.as_ref().unwrap().sink.lock().unwrap();
        assert!(slot.is_none());
    }

    #[test]
    fn a_body_without_text_and_request_id_is_a_bad_request() {
        let dir = scratch("deliver-bad");
        let (hub, shared) = hub(&dir, None);
        for body in [r#"{"text":"no id"}"#, r#"{"requestId":"r5"}"#, "not json"] {
            assert_eq!(respond(&post(Some("secret"), body), &hub).0, "400 Bad Request");
        }
        assert!(shared.0.lock().unwrap().is_empty());
    }
}
