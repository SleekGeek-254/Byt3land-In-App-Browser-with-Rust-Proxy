// src-tauri/src/proxy.rs
//
// Server-side URL proxy — fetches external pages with reqwest, rewrites
// relative links to go back through the proxy, and returns the HTML to the
// frontend.  Because the fetch happens in Rust, the browser never sees
// X-Frame-Options / CSP headers from the remote site.
//
// SETUP (3 steps):
//   1. Drop this file into src-tauri/src/proxy.rs
//   2. Add `mod proxy;` to lib.rs
//   3. Add `proxy::proxy_fetch` and `proxy::proxy_resource` to invoke_handler!

use reqwest::header::{ CONTENT_TYPE, USER_AGENT, ACCEPT, ACCEPT_LANGUAGE };
use serde::{ Deserialize, Serialize };
use reqwest::{ Client, Method };
use base64::Engine;
use std::net::IpAddr;
use regex::{ Regex, Captures };
use lazy_static::lazy_static;

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct ProxyResponse {
    pub html: String,
    pub final_url: String,
    pub content_type: String,
    pub title: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResourceResponse {
    /// base64-encoded body
    pub data: String,
    pub content_type: String,
    pub ok: bool,
}

#[derive(Debug, Deserialize)]
pub struct ProxyRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProxyResponseFull {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String, // base64 encoded if binary, otherwise plain text
    pub is_binary: bool,
}

// ── Shared HTTP Client with Cookie Store ─────────────────────────────────────

lazy_static! {
    static ref SHARED_CLIENT: Client = {
        Client::builder()
            .cookie_store(true) // Keep session cookies across requests
            .user_agent(
                "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
            )
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(
                    USER_AGENT,
                    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
                        .parse()
                        .unwrap()
                );
                headers.insert(
                    ACCEPT,
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                        .parse()
                        .unwrap()
                );
                headers.insert(ACCEPT_LANGUAGE, "en-US,en;q=0.5".parse().unwrap());
                headers
            })
            .redirect(reqwest::redirect::Policy::limited(10))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("Failed to build shared HTTP client")
    };
}

// ── URL Safety Validation nill ─────────────────────────────────────────────────────

/// Checks if a URL is safe to proxy (prevents SSRF and internal network access).
/// Returns true if the URL uses http/https and resolves to a public IP address.
fn is_safe_url(url_str: &str) -> bool {
    // Parse URL
    let url = match url::Url::parse(url_str) {
        Ok(u) => u,
        Err(_) => {
            return false;
        }
    };

    // Only allow HTTP/HTTPS schemes
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return false;
    }

    // Get host (domain or IP)
    let host = match url.host_str() {
        Some(h) => h,
        None => {
            return false;
        }
    };

    // Block localhost and loopback addresses
    let host_lower = host.to_lowercase();
    if
        host_lower == "localhost" ||
        host_lower == "127.0.0.1" ||
        host_lower == "::1" ||
        host_lower.starts_with("127.")
    {
        return false;
    }

    // Resolve host to IP address(es) and check for private ranges
    // Use blocking DNS resolution in async context via spawn_blocking
    // We'll handle this inside the commands to avoid blocking.
    // For the static check, we'll do a best-effort check on IP literals.
    if let Ok(ip_addr) = host.parse::<IpAddr>() {
        // It's an IP address directly, check ranges
        return !is_private_ip(ip_addr);
    }

    // For domain names, we need to resolve them – we'll do that in the command
    // with async DNS and check each resolved IP.
    true // passed static checks, will check IPs after resolution
}

/// Returns true if the IP address is in a private/loopback/link-local range.
fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_loopback() || // 127.0.0.0/8
                ipv4.is_private() || // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
                ipv4.is_link_local() || // 169.254.0.0/16
                ipv4.is_unspecified() || // 0.0.0.0
                ipv4.is_broadcast() // 255.255.255.255
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback() || // ::1
                ipv6.is_unicast_link_local() || // fe80::/10
                ipv6.is_unique_local() || // fc00::/7 (ULA)
                ipv6.is_unspecified() // ::
        }
    }
}

/// Resolves a host to IP addresses and checks if any are private.
/// Returns true if the host is safe (all resolved IPs are public).
async fn is_host_safe(host: &str) -> bool {
    // If it's already an IP literal, check it directly
    if let Ok(ip_addr) = host.parse::<IpAddr>() {
        return !is_private_ip(ip_addr);
    }

    // Resolve DNS (async)
    let host_owned = host.to_string();
    match tokio::net::lookup_host((host_owned.as_str(), 0)).await {
        Ok(addrs) => {
            for addr in addrs {
                if is_private_ip(addr.ip()) {
                    return false;
                }
            }
            true // All resolved IPs are public
        }
        Err(_) => false, // DNS resolution failed, block for safety
    }
}

/// Full validation including DNS resolution.
async fn validate_url(url_str: &str) -> Result<(), String> {
    let url = url::Url::parse(url_str).map_err(|e| format!("Invalid URL: {}", e))?;

    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("Unsupported scheme: {}", scheme));
    }

    let host = url.host_str().ok_or("No host in URL")?;

    // Static checks first
    let host_lower = host.to_lowercase();
    if host_lower == "localhost" || host_lower == "127.0.0.1" || host_lower == "::1" {
        return Err("Access to localhost is blocked".to_string());
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_private_ip(ip) {
            return Err("Access to private IP ranges is blocked".to_string());
        }
    }

    // For domain names, resolve and check IPs
    if !is_host_safe(host).await {
        return Err("Domain resolves to private/internal IP address".to_string());
    }

    Ok(())
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Fetches an HTML page and rewrites all relative URLs so that subsequent
/// sub-resource loads (images, CSS, JS) route back through `proxy_resource`.
#[tauri::command]
pub async fn proxy_fetch(url: String) -> Result<ProxyResponse, String> {
    validate_url(&url).await?;

    let mut request = SHARED_CLIENT.get(&url);

    // Override Origin and Referer
    if let Ok(parsed) = url::Url::parse(&url) {
        let _origin = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""));
        request = request.header("Referer", &url);
    }

    let response = request.send().await.map_err(|e| format!("Request failed: {e}"))?;

    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/html")
        .to_string();

    let body = response.text().await.map_err(|e| format!("Failed to read body: {e}"))?;

    let is_html = content_type.contains("html");
    let (html, title) = if is_html {
        let rewritten = rewrite_html(&body, &final_url);
        let title = extract_title(&body);
        (rewritten, title)
    } else {
        (body, None)
    };

    Ok(ProxyResponse { html, final_url, content_type, title })
}

/// Fetches a sub-resource (image, CSS, JS, font, etc.) and returns it as
/// base64 so the frontend can inject it as a data: URL.
#[tauri::command]
pub async fn proxy_resource(url: String) -> Result<ResourceResponse, String> {
    if url.starts_with("data:") || url.starts_with("blob:") {
        return Ok(ResourceResponse {
            data: url,
            content_type: String::new(),
            ok: true,
        });
    }

    validate_url(&url).await?;

    let resp = match SHARED_CLIENT.get(&url).send().await {
        Ok(r) => r,
        Err(_) => {
            return Ok(ResourceResponse {
                data: String::new(),
                content_type: String::new(),
                ok: false,
            });
        }
    };

    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let bytes = resp.bytes().await.map_err(|e| format!("Failed to read resource body: {e}"))?;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(ResourceResponse { data, content_type, ok: true })
}

/// More general version supporting POST, custom headers, etc.
#[tauri::command]
pub async fn proxy_request(req: ProxyRequest) -> Result<ProxyResponseFull, String> {
    validate_url(&req.url).await?;

    let method = Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
    let mut request = SHARED_CLIENT.request(method, &req.url);

    // Forward all headers from the frontend (including Accept, Cookie, etc.)
    for (name, value) in &req.headers {
        request = request.header(name, value);
    }

    // 🔧 Override Origin and Referer to match the target domain
    if let Ok(parsed_url) = url::Url::parse(&req.url) {
        let origin = format!("{}://{}", parsed_url.scheme(), parsed_url.host_str().unwrap_or(""));
        request = request.header("Origin", origin);
        request = request.header("Referer", &req.url);
    }

    if let Some(body) = &req.body {
        request = request.body(body.clone());
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let content_type = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.as_str())
        .unwrap_or("");

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let (body, is_binary) = if
        content_type.contains("text/") ||
        content_type.contains("json") ||
        content_type.contains("javascript")
    {
        (String::from_utf8_lossy(&bytes).to_string(), false)
    } else {
        (base64::engine::general_purpose::STANDARD.encode(&bytes), true)
    };

    Ok(ProxyResponseFull {
        status: status.as_u16(),
        status_text,
        headers,
        body,
        is_binary,
    })
}

// ── Helpers ───────────────────────────────────────────────────────────────────
 
// ─────────────────────────────────────────────────────────────────────────────
// Resource URL Rewriting (new)
// ─────────────────────────────────────────────────────────────────────────────

/// Attributes that contain URLs we want to proxy.
/// (tag, attribute) pairs.
const RESOURCE_ATTRS: &[(&str, &str)] = &[
    ("img", "src"),
    ("img", "srcset"),
    ("source", "src"),
    ("source", "srcset"),
    ("video", "src"),
    ("video", "poster"),
    ("audio", "src"),
    ("link", "href"), // stylesheets
    ("script", "src"),
    ("embed", "src"),
    ("iframe", "src"),
    ("object", "data"),
    ("use", "href"), // SVG <use href="...">
    ("image", "href"), // SVG <image href="...">
];

/// A tiny 1x1 transparent GIF (base64) to use as a placeholder for images/videos.
const PLACEHOLDER_1X1_GIF: &str =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// Helper functions for placeholder selection (all have the same type: fn(&str) -> &'static str)
fn placeholder_image(_url: &str) -> &'static str {
    PLACEHOLDER_1X1_GIF
}

fn placeholder_script(_url: &str) -> &'static str {
    "data:text/javascript;base64,"
}

fn placeholder_stylesheet(url: &str) -> &'static str {
    if url.contains(".css") || url.contains("stylesheet") {
        "data:text/css;base64,"
    } else {
        PLACEHOLDER_1X1_GIF
    }
}

fn rewrite_resource_urls(html: &str, base: &url::Url) -> String {
    let mut result = html.to_string();

    let resolve = |url: &str| -> String {
        if url.starts_with("data:") || url.starts_with("blob:") || url.starts_with("javascript:") {
            return url.to_string();
        }
        if url.starts_with("http://") || url.starts_with("https://") {
            url.to_string()
        } else {
            base.join(url)
                .map(|u| u.to_string())
                .unwrap_or_else(|_| url.to_string())
        }
    };

    // Array of (tag, attribute, placeholder_fn) where all placeholder functions have the same type.
    let simple_attrs: &[(&str, &str, fn(&str) -> &'static str)] = &[
        ("img", "src", placeholder_image),
        ("video", "poster", placeholder_image),
        ("audio", "src", placeholder_image),
        ("embed", "src", placeholder_image),
        ("iframe", "src", placeholder_image),
        ("object", "data", placeholder_image),
        ("use", "href", placeholder_image),
        ("image", "href", placeholder_image),
        ("script", "src", placeholder_script),
        ("link", "href", placeholder_stylesheet),
    ];

    for (tag, attr, placeholder_fn) in simple_attrs {
        let pattern = format!(
            r#"<{tag}\b[^>]*?\s{attr}\s*=\s*["']([^"']+)["']"#,
            tag = tag,
            attr = attr
        );
        let re = Regex::new(&pattern).unwrap();

        result = re
            .replace_all(&result, |caps: &Captures| {
                let full_match = caps.get(0).unwrap().as_str();
                let url = caps.get(1).unwrap().as_str();
                let absolute_url = resolve(url);
                let placeholder = placeholder_fn(url);

                if let Some(gt_pos) = full_match.rfind('>') {
                    let (before_gt, after_gt) = full_match.split_at(gt_pos);
                    format!(
                        "{before_gt} data-original-{attr}=\"{absolute_url}\"{after_gt}",
                        before_gt = before_gt,
                        after_gt = after_gt,
                        attr = attr,
                        absolute_url = absolute_url
                    ).replace(url, placeholder)
                } else {
                    full_match.to_string()
                }
            })
            .to_string();
    }

    // srcset handling (unchanged)
    let srcset_pattern = r#"<((?:img|source))\b[^>]*?\ssrcset\s*=\s*["']([^"']+)["']"#;
    let re = Regex::new(srcset_pattern).unwrap();
    result = re
        .replace_all(&result, |caps: &Captures| {
            let full_match = caps.get(0).unwrap().as_str();
            let srcset_value = caps.get(2).unwrap().as_str();

            let mut new_parts = Vec::new();
            let mut original_urls = Vec::new();

            for part in srcset_value.split(',') {
                let trimmed = part.trim();
                if let Some((url_part, descriptor)) = trimmed.split_once(char::is_whitespace) {
                    let abs_url = resolve(url_part);
                    original_urls.push(abs_url);
                    new_parts.push(format!("{} {}", PLACEHOLDER_1X1_GIF, descriptor));
                } else {
                    let abs_url = resolve(trimmed);
                    original_urls.push(abs_url);
                    new_parts.push(PLACEHOLDER_1X1_GIF.to_string());
                }
            }

            let new_srcset = new_parts.join(", ");
            let original_joined = original_urls.join(", ");

            let tag = full_match.replace(srcset_value, &new_srcset);
            if let Some(gt_pos) = tag.rfind('>') {
                let (before_gt, after_gt) = tag.split_at(gt_pos);
                format!("{before_gt} data-original-srcset=\"{original_joined}\"{after_gt}")
            } else {
                tag
            }
        })
        .to_string();

    result
}

/// Finds the position of an attribute name in a tag string (case-insensitive).
fn find_attr_pos(tag_lower: &str, attr_name: &str) -> Option<usize> {
    let needle = format!("{}=", attr_name);
    // Simple search, won't handle quoted attribute names with spaces perfectly, but works for well-formed HTML.
    tag_lower.find(&needle)
}

/// Given the start of an attribute (including name and '='), extracts the value range and quote char.
/// Returns (value_start, value_end, quote_char).
fn extract_attr_range(
    tag: &str,
    attr_start: usize,
    attr_name_len: usize
) -> Option<(usize, usize, char)> {
    let after_eq = attr_start + attr_name_len + 1;
    let rest = &tag[after_eq..];
    let first_char = rest.chars().next()?;

    let (quote_char, start_offset) = if first_char == '"' || first_char == '\'' {
        (first_char, 1)
    } else {
        // Unquoted attribute – find space or >
        let end = rest.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(rest.len());
        return Some((after_eq, after_eq + end, '\0'));
    };

    let value_start = after_eq + start_offset;
    let value_rest = &tag[value_start..];
    let value_len = value_rest.find(quote_char)?;
    Some((value_start, value_start + value_len, quote_char))
}

/// Rewrites HTML for safe embedding in srcdoc iframe:
///   1. Removes CSP meta tags (external sites might set their own)
///   2. Removes existing <base> tags
///   3. Converts inline <script> to data: URLs (bypasses CSP inline-script blocking)
///   4. Injects <base> tag
///   5. Adds data-proxy-url to <a> tags for navigation interception
fn rewrite_html(html: &str, base_url: &str) -> String {
    let Ok(parsed_base) = url::Url::parse(base_url) else {
        return html.to_string();
    };

    let mut out = html.to_string();

    // 1. Remove CSP meta tags
    out = remove_csp_meta_tags(&out);

    // 2. Remove existing <base> tags
    out = remove_tags(&out, "base");

    // 3. Convert inline scripts to data: URLs
    out = rewrite_inline_scripts(&out);

    // 4. Rewrite resource URLs (img src, link href, etc.) to placeholders
    out = rewrite_resource_urls(&out, &parsed_base);

    // 5. Inject our own <base>
    let base_tag = format!(r#"<base href="{base_url}">"#);
    if let Some(pos) = out.to_lowercase().find("<head>") {
        out.insert_str(pos + 6, &base_tag);
    } else if let Some(pos) = out.to_lowercase().find("<html") {
        if let Some(end) = out[pos..].find('>') {
            out.insert_str(pos + end + 1, &format!("<head>{base_tag}</head>"));
        }
    } else {
        out = format!("{base_tag}{out}");
    }

    // 6. Mark <a href> links for navigation interception
    out = rewrite_links(&out, &parsed_base);

    out
}

/// Removes <meta http-equiv="Content-Security-Policy" ...> tags from HTML.
/// External sites often include these, and they would conflict with our sandbox.
fn remove_csp_meta_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut rest = html;

    loop {
        // Find next <meta tag
        let meta_start = match rest.to_lowercase().find("<meta") {
            Some(pos) => pos,
            None => {
                result.push_str(rest);
                break;
            }
        };

        result.push_str(&rest[..meta_start]);
        rest = &rest[meta_start..];

        // Find end of this meta tag
        let tag_end = match rest.find('>') {
            Some(pos) => pos,
            None => {
                result.push_str(rest);
                break;
            }
        };

        let tag_content = &rest[..tag_end + 1];
        let tag_lower = tag_content.to_lowercase();

        // Check if this is a CSP meta tag
        if tag_lower.contains("http-equiv") && tag_lower.contains("content-security-policy") {
            // Skip this tag entirely
            rest = &rest[tag_end + 1..];
        } else {
            // Keep this meta tag
            result.push_str(tag_content);
            rest = &rest[tag_end + 1..];
        }
    }

    result
}

/// Converts inline <script>...</script> tags to <script src="data:text/javascript;base64,...">
///
/// WHY: The Tauri CSP has both 'unsafe-inline' AND sha256 hashes in script-src.
/// Per CSP spec, when hashes are present, 'unsafe-inline' is IGNORED.
/// Since our srcdoc iframe inherits this CSP, inline scripts from external sites
/// are blocked (they don't match our hashes).
///
/// SOLUTION: Convert inline scripts to data: URLs, which ARE allowed by 'data:' in script-src.
fn rewrite_inline_scripts(html: &str) -> String {
    use base64::Engine;

    let mut result = String::with_capacity(html.len() + 4096);
    let mut rest = html;

    loop {
        // Find next <script tag (case-insensitive)
        let script_start = match rest.to_lowercase().find("<script") {
            Some(pos) => pos,
            None => {
                result.push_str(rest);
                break;
            }
        };

        // Push everything before the script tag
        result.push_str(&rest[..script_start]);
        rest = &rest[script_start..];

        // Find end of opening <script ...> tag
        let tag_end = match rest.find('>') {
            Some(pos) => pos,
            None => {
                result.push_str(rest);
                break;
            }
        };

        // Extract attributes (everything between <script and >)
        let attrs = &rest[7..tag_end];

        // Check if it has a src attribute (external script) — leave as-is
        let attrs_lower = attrs.to_lowercase();
        if attrs_lower.contains("src=") {
            // Find the closing </script> and keep everything as-is
            if let Some(closing_pos) = rest.to_lowercase().find("</script>") {
                result.push_str(&rest[..closing_pos + 9]);
                rest = &rest[closing_pos + 9..];
            } else {
                result.push_str(rest);
                break;
            }
            continue;
        }

        // Find closing </script>
        let closing_pos = match rest.to_lowercase().find("</script>") {
            Some(pos) => pos,
            None => {
                result.push_str(rest);
                break;
            }
        };

        // Extract script content
        let content = &rest[tag_end + 1..closing_pos];

        // Skip empty scripts
        if content.trim().is_empty() {
            rest = &rest[closing_pos + 9..];
            continue;
        }

        // Get type attribute (if present)
        let script_type = extract_attr(attrs, "type").unwrap_or("");

        // Only convert executable JavaScript
        // Skip templates (text/template, text/html), JSON, LD+JSON, etc.
        let is_executable =
            script_type.is_empty() ||
            script_type == "text/javascript" ||
            script_type == "application/javascript";

        if !is_executable {
            // Keep non-executable scripts as-is (templates, JSON-LD, etc.)
            result.push_str(&rest[..closing_pos + 9]);
            rest = &rest[closing_pos + 9..];
            continue;
        }

        // Preserve certain attributes (async, defer, crossorigin, etc.)
        let mut preserved_attrs = String::new();
        for attr in ["async", "defer", "crossorigin", "integrity"] {
            if attrs_lower.contains(attr) {
                if let Some(val) = extract_attr(attrs, attr) {
                    if val.is_empty() {
                        preserved_attrs.push_str(&format!(" {}", attr));
                    } else {
                        preserved_attrs.push_str(&format!(" {}=\"{}\"", attr, val));
                    }
                }
            }
        }

        // Convert inline script to data: URL
        let encoded = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
        result.push_str(
            &format!(
                r#"<script{} src="data:text/javascript;base64,{}"></script>"#,
                preserved_attrs,
                encoded
            )
        );
        rest = &rest[closing_pos + 9..];
    }

    result
}

fn remove_tags(html: &str, tag: &str) -> String {
    // Very simple removal — works for well-formed single-line tags
    let open = format!("<{tag}");
    let mut result = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.to_lowercase().find(&open) {
        result.push_str(&rest[..start]);
        rest = &rest[start..];
        // find end of tag
        if let Some(end) = rest.find('>') {
            rest = &rest[end + 1..];
        } else {
            break;
        }
    }
    result.push_str(rest);
    result
}

/// Adds `data-proxy-url="<absolute>"` to every `<a href="...">` so the
/// frontend JavaScript can intercept clicks and route through proxy_fetch.
fn rewrite_links(html: &str, base: &url::Url) -> String {
    let mut out = String::with_capacity(html.len() + 1024);
    let mut rest = html;

    while let Some(tag_start) = rest.to_lowercase().find("<a ") {
        out.push_str(&rest[..tag_start]);
        rest = &rest[tag_start..];

        let tag_end = rest.find('>').unwrap_or(rest.len() - 1);
        let tag = &rest[..tag_end + 1];

        // Extract href value
        let abs = extract_attr(tag, "href").and_then(|href| {
            if href.starts_with("javascript:") || href.starts_with('#') || href.is_empty() {
                None
            } else if href.starts_with("http://") || href.starts_with("https://") {
                Some(href.to_string())
            } else {
                base.join(href)
                    .ok()
                    .map(|u| u.to_string())
            }
        });

        if let Some(abs_url) = abs {
            // Insert data-proxy-url before closing >
            let insert_pos = tag_end; // position of '>'
            out.push_str(&rest[..insert_pos]);
            out.push_str(&format!(r#" data-proxy-url="{abs_url}""#));
            out.push('>');
        } else {
            out.push_str(tag);
        }

        rest = &rest[tag_end + 1..];
    }

    out.push_str(rest);
    out
}

fn extract_attr<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    let lower = tag.to_lowercase();
    let needle = format!("{attr}=");
    let start = lower.find(&needle)? + needle.len();
    let rest = &tag[start..];
    if rest.starts_with('"') {
        let end = rest[1..].find('"')? + 1;
        Some(&rest[1..end])
    } else if rest.starts_with('\'') {
        let end = rest[1..].find('\'')? + 1;
        Some(&rest[1..end])
    } else {
        // unquoted boolean attribute or value
        let end = rest.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(rest.len());
        Some(&rest[..end])
    }
}

fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title>")? + 7;
    let end = lower[start..].find("</title>")? + start;
    Some(html[start..end].trim().to_string())
}
