# In-App Browser with Rust Proxy

A sophisticated in-app browser implementation for Tauri applications that bypasses browser security restrictions by routing all network requests through a Rust backend. This allows you to display external websites inside your app without being blocked by Content Security Policy (CSP), X-Frame-Options, or other browser security headers.

## 🎯 Problem Solved

Modern browsers implement strict security policies that prevent embedding arbitrary third-party websites:

- **X-Frame-Options / frame-ancestors** - Sites explicitly block themselves from being displayed in iframes
- **Content Security Policy (CSP)** - Inline scripts and resource loading get blocked by CSP hash restrictions
- **CORS restrictions** - Cross-origin requests are blocked by browser security policies
- **Same-origin policy** - Prevents JavaScript from accessing resources across domains

This solution bypasses all these restrictions by fetching content server-side (in Rust) and rewriting it for safe embedding.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        React Frontend                           │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  InAppBrowser Component (iframe with blob URL)             │ │
│  └────────────────────────────────────────────────────────────┘ │
└────────────────────────────┬────────────────────────────────────┘
                             │ postMessage / invoke
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Rust Backend (proxy.rs)                      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  proxy_fetch    - Fetch HTML & rewrite for embedding       │ │
│  │  proxy_resource - Fetch resources as base64 data URLs      │ │
│  │  proxy_request  - General XHR/fetch proxy with headers     │ │
│  └────────────────────────────────────────────────────────────┘ │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP requests
                             ▼
                      External Websites
```

## 📁 Components

### 1. `src-tauri/src/proxy.rs` (822 lines)

The Rust backend that handles all HTTP requests and HTML transformation.

#### Tauri Commands

| Command | Purpose |
|---------|---------|
| `proxy_fetch(url)` | Fetches HTML, rewrites it, and returns ready-to-embed content |
| `proxy_resource(url)` | Fetches images/CSS/JS and returns as base64-encoded data URL |
| `proxy_request(req)` | General proxy for XHR/fetch with full header/method/body control |

#### Security Features

- **SSRF Protection**: Prevents Server-Side Request Forgery by blocking:
  - localhost and loopback addresses (127.0.0.1, ::1)
  - Private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
  - Link-local addresses (169.254.0.0/16, fe80::/10)
  - Only allows http/https schemes

- **DNS Resolution Validation**: Resolves domain names and validates each IP address to prevent DNS rebinding attacks

- **Cookie Store**: Maintains session cookies across requests using reqwest's built-in cookie store

#### HTML Transformations

The `rewrite_html()` function applies several transformations:

1. **Removes CSP meta tags** - External sites often include `<meta http-equiv="Content-Security-Policy">` that would conflict with our sandbox

2. **Removes existing `<base>` tags** - To prevent conflicts with our injected base tag

3. **Converts inline scripts to data: URLs** - When CSP has sha256 hashes, `unsafe-inline` is ignored. Converting to data: URLs bypasses this restriction

4. **Rewrites resource URLs** - Images, CSS, JS, videos, fonts are replaced with placeholder URLs; original URLs preserved in `data-original-*` attributes

5. **Injects `<base>` tag** - Ensures relative URLs resolve correctly

6. **Adds `data-proxy-url` to links** - Enables JavaScript to intercept navigation clicks

### 2. `src/components/InAppBrowser.tsx` (968 lines)

The React frontend component that provides a full browser UI and manages the proxying.

#### Features

- **Browser Chrome UI**
  - Address bar with URL input
  - Back/Forward navigation buttons
  - Reload button
  - Close button
  - Loading indicator
  - Error display with retry option

- **Navigation History**
  - Tracks visited URLs
  - Manages history state
  - Enables back/forward navigation

- **Script Injection**
  - Injects a comprehensive JavaScript shim into every proxied page
  - Uses base64-encoded data: URL (required to bypass CSP hash restrictions)

- **Resource Proxying**
  - Overrides `window.fetch` to route through Rust backend
  - Overrides `XMLHttpRequest` to route through Rust backend
  - Prevents `document.cookie` access
  - DOM scanner with MutationObserver to catch dynamically added resources

#### Injected JavaScript Capabilities

The injected script provides:

1. **Fetch Override**
   ```javascript
   // All fetch calls are proxied through Rust
   window.fetch = function(input, init) {
     return proxyRequest(method, url, headers, body)
       .then(responseData => new Response(...));
   };
   ```

2. **XHR Override**
   - Full XMLHttpRequest API implementation
   - Routes through `proxy_request` backend command
   - Supports all standard XHR properties/methods

3. **Resource Fetching**
   - Scans DOM for resources (img src, link href, script src, etc.)
   - Fetches via `proxy_resource` backend command
   - Replaces URLs with base64 data URLs

4. **Style URL Proxying**
   - Scans inline styles for `url()` references
   - Scans `<style>` elements for `url()` references
   - Replaces with proxied data URLs

5. **Navigation Interception**
   - Intercepts clicks on links with `data-proxy-url` attribute
   - Sends `proxy-navigate` message to parent window
   - Triggers new page load through proxy

6. **Header Injection**
   - Adds Sec-Fetch-* headers for realistic requests
   - Adds Referer header
   - Special handling for Instagram (X-IG-App-ID, X-Requested-With)

## 🚀 Setup Instructions

### 1. Add Dependencies

Add to `src-tauri/Cargo.toml`:

```toml
[dependencies]
reqwest = { version = "0.11", features = ["cookies"] }
serde = { version = "1.0", features = ["derive"] }
url = "2.4"
regex = "1.10"
lazy_static = "1.4"
base64 = "0.21"
tokio = { version = "1", features = ["net"] }
```

### 2. Add proxy.rs

Place `src-tauri/src/proxy.rs` in your Tauri project.

### 3. Register Module

Add to `src-tauri/src/lib.rs`:

```rust
mod proxy;
```

### 4. Register Commands

Add the proxy commands to your `invoke_handler`:

```rust
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            // ... your other commands
            proxy::proxy_fetch,
            proxy::proxy_resource,
            proxy::proxy_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 5. Use InAppBrowser Component

Copy `src/components/InAppBrowser.tsx` to your React project.

Then use it in your application:

```tsx
import InAppBrowser from "./components/InAppBrowser";

function App() {
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);

  return (
    <div>
      <button onClick={() => setBrowserUrl("https://example.com")}>
        Open Browser
      </button>

      {browserUrl && (
        <InAppBrowser
          url={browserUrl}
          onClose={() => setBrowserUrl(null)}
        />
      )}
    </div>
  );
}
```

## 🔒 Security Considerations

### What's Secured

1. **SSRF Prevention** - Blocks requests to internal networks, localhost, and private IP ranges
2. **Scheme Restriction** - Only allows http/https protocols
3. **DNS Resolution** - Validates all resolved IP addresses
4. **Cookie Isolation** - Cookies are stored in Rust backend, never exposed to browser

### What You Should Be Aware Of

1. **User Privacy** - All user browsing goes through your server
2. **Legal Implications** - You're acting as a proxy for third-party content
3. **Rate Limiting** - Consider adding rate limiting to prevent abuse
4. **Content Filtering** - You may need to implement additional filtering based on your use case

### Recommendations

- Add authentication to your Tauri commands if running in production
- Implement request logging and monitoring
- Consider adding cache headers to proxy responses
- Add timeout handling for long-running requests
- Implement content-type validation

## 🎨 Customization

### Styling

The browser chrome uses inline styles for portability. You can customize the appearance by modifying the `styles` object in `InAppBrowser.tsx`:

```typescript
const styles = {
  chrome: {
    background: "rgba(255, 255, 255, 0.1)",
    // ... other styles
  },
  // ...
};
```

### Sandbox Attributes

The iframe uses these sandbox attributes:

```html
sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
```

Adjust based on your security requirements.

### User Agent

The proxy uses a mobile Chrome user agent by default. Modify in `proxy.rs`:

```rust
"user_agent(
    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36..."
)
```

## 🔧 Technical Details

### Why Use Blob URLs?

Instead of setting `srcdoc` directly, we create a Blob URL:

```typescript
const blob = new Blob([html], { type: "text/html" });
const blobUrl = URL.createObjectURL(blob);
<iframe src={blobUrl} />
```

**Why?**
- `srcdoc` can trigger some security heuristics
- Blob URLs are treated as same-origin, making script injection easier
- Better performance for large HTML documents

### Why Convert Inline Scripts to data: URLs?

When a CSP includes sha256 hashes, the `unsafe-inline` directive is ignored per CSP specification. Converting inline scripts to data: URLs bypasses this because data URLs are treated as external resources and can be whitelisted.

### MutationObserver Pattern

The injected script uses a MutationObserver to catch dynamically added resources:

```javascript
const observer = new MutationObserver((mutations) => {
  for (const mut of mutations) {
    for (const node of mut.addedNodes) {
      // Scan new elements for resources
      scanElementForResources(node);
    }
  }
});
```

This ensures that even if the page dynamically adds images/scripts after load, they still get proxied.

## 📊 Performance Considerations

- **Resource Loading**: All images, CSS, and JS are fetched twice - once by Rust, once when the browser loads the data URL
- **Memory Usage**: Base64 encoding increases data size by ~33%
- **Latency**: Additional round-trip through Rust backend adds latency

### Optimization Tips

1. Implement caching in Rust backend
2. Consider compression for large resources
3. Add lazy loading for images below the fold
4. Debounce resource requests when multiple are added at once

## 🐛 Troubleshooting

### Pages Not Loading

1. Check that proxy commands are registered in `invoke_handler`
2. Verify `mod proxy;` is added to `lib.rs`
3. Check browser console for JavaScript errors
4. Verify Rust backend is running correctly

### Images Not Displaying

1. Check if `proxy_resource` command is working
2. Verify iframe sandbox allows resource loading
3. Check browser console for failed resource loads

### Inline Scripts Not Working

1. Verify CSP is being removed in `rewrite_html()`
2. Check that script is converted to data: URL correctly
3. Verify data: URLs are allowed in your CSP

## 📝 License

This implementation is provided as-is for educational and commercial use.

## 🤝 Contributing

Feel free to submit issues, fork the repository, and create pull requests for any improvements.

## 🙏 Acknowledgments

This implementation demonstrates advanced techniques for:
- Tauri backend communication
- CSP bypass strategies
- DOM manipulation and observation
- Security header handling
- Cross-origin proxying
