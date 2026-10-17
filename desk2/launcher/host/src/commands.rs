//! What the window's page sends the host: a page tab's browser view commands and the window's own frame commands.

use crate::Rect;
use serde::Deserialize;

// ---- the browser pane's page tabs: desk2/web/src/components/servers/native-browser.ts is the other end ----
// An iframe cannot show a site that sends X-Frame-Options or CSP frame-ancestors (most sites with a sign-in), so a
// page tab asks this window for a browser view of its own, placed over the tab. The window's page says where (client
// pixels) and what to show through window.ipc; each view reports its address and title back as an
// `agenthydra:browser` window event.

/// What the window's page asks of a page tab's browser view (HostBrowserIn in native-browser.ts).
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub(crate) enum BrowserCmd {
    /// Show `url` in view `id`, made on first use; no `rect` keeps it hidden.
    Open {
        id: String,
        url: String,
        rect: Option<Rect>,
    },
    /// Move view `id` to `rect`, or hide it.
    Place {
        id: String,
        rect: Option<Rect>,
    },
    Back {
        id: String,
    },
    Forward {
        id: String,
    },
    Reload {
        id: String,
    },
    Close {
        id: String,
    },
    /// Mute or unmute view `id` (ICoreWebView2_8::put_IsMuted).
    Mute {
        id: String,
        muted: bool,
    },
}

impl BrowserCmd {
    fn id(&self) -> &str {
        match self {
            BrowserCmd::Open { id, .. }
            | BrowserCmd::Place { id, .. }
            | BrowserCmd::Back { id }
            | BrowserCmd::Forward { id }
            | BrowserCmd::Reload { id }
            | BrowserCmd::Close { id }
            | BrowserCmd::Mute { id, .. } => id,
        }
    }
}

/// A browser message from the window's page, or None for anything else. A rect with no area means hidden.
pub(crate) fn parse_browser_cmd(text: &str) -> Option<BrowserCmd> {
    #[derive(Deserialize)]
    struct Kind {
        kind: String,
    }
    if serde_json::from_str::<Kind>(text).ok()?.kind != "browser" {
        return None;
    }
    let mut cmd: BrowserCmd = serde_json::from_str(text).ok()?;
    if cmd.id().is_empty() || cmd.id().len() > 64 {
        return None;
    }
    if let BrowserCmd::Open { rect, .. } | BrowserCmd::Place { rect, .. } = &mut cmd {
        *rect = rect.filter(|r| r.w() > 0 && r.h() > 0 && r.w() <= 32_000 && r.h() <= 32_000);
    }
    Some(cmd)
}

// ---- the window's own frame: the page's host bridge is the other end ----
// The page draws its top row as the title bar: `ready` turns Windows' caption off (once), the page's own buttons ask for
// minimize, maximize, close or a resize drag, and the window answers with an `agenthydra:window` event.

/// What the window's page asks of the window (`{"op":"window","action":...}`).
#[derive(Debug, PartialEq)]
pub(crate) enum WindowCmd {
    /// The page has loaded: turn the caption off (once) and say what the window is now.
    Ready,
    Minimize,
    /// Maximize, or restore when maximized.
    Maximize,
    /// What the caption's X does: the placement is saved and the window closes.
    Close,
    /// Start a native resize drag from this edge.
    Resize(Edge),
    /// Start the window's move, as a press on the caption does (a title bar the page's drag regions cannot cover).
    Drag,
    /// Where the page's three window buttons are, in client pixels, or None while it shows none: the caption sink
    /// goes over them (win::caption_sink).
    Buttons(Option<Rect>),
    /// Shrink to a strip of `width` pixels on the right edge of the work area, topmost (clamped to 160..=1200).
    Collapse {
        width: i32,
    },
    /// Back to the placement remembered when the window collapsed.
    Expand,
}

/// The edges the page starts a resize drag from (the top ones: the page draws those).
#[derive(Debug, PartialEq)]
pub(crate) enum Edge {
    North,
    NorthEast,
    NorthWest,
}

/// A window message from the window's page, or None for anything else; an unknown action is ignored.
pub(crate) fn parse_window_cmd(text: &str) -> Option<WindowCmd> {
    #[derive(Deserialize)]
    struct Msg {
        op: String,
        action: String,
        edge: Option<String>,
        /// left, top, width, height
        rect: Option<[i32; 4]>,
        width: Option<i64>,
    }
    let m: Msg = serde_json::from_str(text).ok()?;
    if m.op != "window" {
        return None;
    }
    Some(match m.action.as_str() {
        "ready" => WindowCmd::Ready,
        "minimize" => WindowCmd::Minimize,
        "maximize" => WindowCmd::Maximize,
        "close" => WindowCmd::Close,
        "drag" => WindowCmd::Drag,
        "collapse" => WindowCmd::Collapse {
            width: m.width?.clamp(160, 1200) as i32,
        },
        "expand" => WindowCmd::Expand,
        // Three buttons are a few hundred pixels at most; anything else is not the page's buttons.
        "buttons" => WindowCmd::Buttons(match m.rect {
            None => None,
            Some([left, top, w, h]) if (1..=2000).contains(&w) && (1..=400).contains(&h) => {
                Some(Rect {
                    left,
                    top,
                    right: left + w,
                    bottom: top + h,
                })
            }
            Some(_) => return None,
        }),
        "resize" => WindowCmd::Resize(match m.edge.as_deref()? {
            "n" => Edge::North,
            "ne" => Edge::NorthEast,
            "nw" => Edge::NorthWest,
            _ => return None,
        }),
        _ => return None,
    })
}
