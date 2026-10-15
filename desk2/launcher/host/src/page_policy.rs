//! Which addresses a page tab's browser view may open, and how a local page is remembered for its view.

pub(crate) fn origin_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    format!("{}://{}", url.split("://").next().unwrap_or("http"), host)
}

/// Where a page tab's view may go: http and https except AgentHydra's own window, and about: and blob: pages.
pub(crate) fn page_url_allowed(url: &str, desk_origin: &str) -> bool {
    let u = url.to_ascii_lowercase();
    if u.starts_with("about:") || u.starts_with("blob:") {
        return true;
    }
    (u.starts_with("http://") || u.starts_with("https://"))
        && origin_of(&u) != desk_origin.to_ascii_lowercase()
}

/// A local page on this PC (file:///C:/...). Only the Desk opens one; a web page reaches one only as a link from a local page.
pub(crate) fn is_local_page(url: &str) -> bool {
    url.to_ascii_lowercase().starts_with("file:///")
}

/// Where a local page is remembered: lower case, with %XX escapes undone (WebView2 may escape a space in a path).
pub(crate) fn local_key(url: &str) -> String {
    let b = url.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = b
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (b[i], hex) {
            (b'%', Some(v)) => {
                out.push(v);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_ascii_lowercase()
}

/// The address the Desk may open in a page view: a local page, or what page_url_allowed allows.
pub(crate) fn desk_page_allowed(url: &str, desk_origin: &str) -> bool {
    is_local_page(url) || page_url_allowed(url, desk_origin)
}
