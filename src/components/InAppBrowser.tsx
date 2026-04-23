// components/InAppBrowser.tsx
//
// Custom in-app browser that routes ALL fetches through Rust (proxy.rs).

import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  ArrowLeft,
  ArrowRight,
  RotateCcw, 
  AlertTriangle,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProxyResponse {
  html: string;
  final_url: string;
  content_type: string;
  title: string | null;
}

interface ResourceResponse {
  data: string;
  content_type: string;
  ok: boolean;
}

interface ProxyResponseFull {
  status: number;
  status_text: string;
  headers: [string, string][];
  body: string;
  is_binary: boolean;
}

interface HistoryEntry {
  url: string;
  title: string;
}

interface InAppBrowserProps {
  url: string;
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

const InAppBrowser: React.FC<InAppBrowserProps> = ({ url, onClose }) => {
  const [blobUrl, setBlobUrl] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inputUrl, setInputUrl] = useState(url);
  const [pageTitle, setPageTitle] = useState<string>("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  const history = useRef<HistoryEntry[]>([]);
  const histIdx = useRef<number>(-1);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Revoke previous blob URL when a new one is created
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const navigate = useCallback(
    async (targetUrl: string, pushHistory = true) => {
      let normalized = targetUrl.trim();
      if (!/^https?:\/\//i.test(normalized))
        normalized = "https://" + normalized;

      setIsLoading(true);
      setError(null);
      setInputUrl(normalized);

      try {
        const result = await invoke<ProxyResponse>("proxy_fetch", {
          url: normalized,
        });

        let augmented = injectProxyScript(result.html);
        augmented = injectScrollbarStyles(augmented);


        // Create blob URL
        const blob = new Blob([augmented], { type: "text/html" });
        const newBlobUrl = URL.createObjectURL(blob);
 
        setBlobUrl(newBlobUrl);
        setInputUrl(result.final_url);
        setPageTitle(result.title ?? displayHost(result.final_url));

        if (pushHistory) {
          history.current = history.current.slice(0, histIdx.current + 1);
          history.current.push({
            url: result.final_url,
            title: result.title ?? "",
          });
          histIdx.current = history.current.length - 1;
        }

        setCanGoBack(histIdx.current > 0);
        setCanGoForward(histIdx.current < history.current.length - 1);
      } catch (e: any) {
        setError(String(e));
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  // Initial load
  useEffect(() => {
    navigate(url);
  }, [url]);

  // ── Listen for navigation + resource requests from the srcdoc iframe ─────

  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      // Security: Only accept messages from our own iframe
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (!e.data || typeof e.data !== "object") return;

      // Link click inside the iframe → navigate via proxy
      if (e.data.type === "proxy-navigate") {
        navigate(e.data.url);
        return;
      }

      // Image / resource request from iframe → fetch via Rust, send back
      if (e.data.type === "proxy-resource") {
        try {
          const result = await invoke<ResourceResponse>("proxy_resource", {
            url: e.data.url,
          });
          (e.source as Window)?.postMessage(
            {
              type: "proxy-resource-response",
              id: e.data.id,
              attr: e.data.attr,
              data: result.data,
              contentType: result.content_type,
              ok: result.ok,
            },
            "*",
          );
        } catch {
          (e.source as Window)?.postMessage(
            {
              type: "proxy-resource-response",
              id: e.data.id,
              attr: e.data.attr,
              ok: false,
            },
            "*",
          );
        }
      }

      // General XHR/fetch proxy request
      if (e.data.type === "proxy-request") {
        const { id, method, url, headers, body } = e.data;
        try {
          const result = await invoke<ProxyResponseFull>("proxy_request", {
            req: { method, url, headers, body },
          });
          (e.source as Window)?.postMessage(
            {
              type: "proxy-request-response",
              id: id,
              status: result.status,
              statusText: result.status_text,
              headers: result.headers,
              body: result.body,
              isBinary: result.is_binary,
              error: null,
            },
            "*",
          );
        } catch (err: any) {
          (e.source as Window)?.postMessage(
            {
              type: "proxy-request-response",
              id: id,
              error: err.toString(),
            },
            "*",
          );
        }
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [navigate]);

  // ── History controls ──────────────────────────────────────────────────────

  const goBack = () => {
    if (histIdx.current > 0) {
      histIdx.current -= 1;
      navigate(history.current[histIdx.current].url, false);
      setCanGoBack(histIdx.current > 0);
      setCanGoForward(true);
    }
  };

  const goForward = () => {
    if (histIdx.current < history.current.length - 1) {
      histIdx.current += 1;
      navigate(history.current[histIdx.current].url, false);
      setCanGoBack(true);
      setCanGoForward(histIdx.current < history.current.length - 1);
    }
  };

  const reload = () => navigate(inputUrl, false);

  const handleAddressKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") navigate(inputUrl);
  };

  // ── Lock body scroll while open ───────────────────────────────────────────

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: "100%", opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: "100%", opacity: 0 }}
        transition={{ type: "spring", damping: 28, stiffness: 300 }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          background: "#0a0a0f",
        }}
      >
        {/* floating chrome */}
        <div style={styles.chromebox}>
          <div className="chrome" style={styles.chrome}>
            <button
              onClick={goBack}
              disabled={!canGoBack}
              style={navBtn(!canGoBack)}
              aria-label="Back"
            >
              <ArrowLeft size={17} />
            </button>
            <button
              onClick={goForward}
              disabled={!canGoForward}
              style={navBtn(!canGoForward)}
              aria-label="Forward"
            >
              <ArrowRight size={17} />
            </button>
            <button onClick={reload} style={navBtn(false)} aria-label="Reload">
              <RotateCcw size={15} />
            </button>

            <div style={styles.addressBar}>
              {isLoading && (
                <motion.div
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ duration: 1.2, repeat: Infinity }}
                  style={styles.loadingDot}
                />
              )}
              <input
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                onKeyDown={handleAddressKeyDown}
                style={styles.addressInput}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>

            <motion.button
              onClick={onClose}
              whileTap={{ scale: 0.88 }}
              aria-label="Close"
              style={styles.closeBtn}
            >
              <X size={15} strokeWidth={2.5} />
            </motion.button>
          </div>
        </div>

        {/* Loading bar */}
        <AnimatePresence>
          {isLoading && (
            <motion.div
              initial={{ scaleX: 0, opacity: 1 }}
              animate={{ scaleX: 0.85 }}
              exit={{ scaleX: 1, opacity: 0 }}
              transition={{ duration: 1.4, ease: "easeOut" }}
              style={styles.progressBar}
            />
          )}
        </AnimatePresence>

        {/* Content */}
        {error ? (
          <ErrorView message={error} onRetry={reload} />
        ) : (
          <iframe
            ref={iframeRef}
            src={blobUrl} // ← use blob URL
            title={pageTitle || "Page"}
            className="inAppBrowser"
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            style={{
              flex: 1,
              border: "none",
              width: "100%",
              background: "#fff",
            }}
            onLoad={() => setIsLoading(false)}
          />
        )}
      </motion.div>
    </AnimatePresence>
  );
};

// ── Error view ────────────────────────────────────────────────────────────────

const ErrorView: React.FC<{ message: string; onRetry: () => void }> = ({
  message,
  onRetry,
}) => (
  <div
    style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "1rem",
      padding: "2rem",
      color: "#9ca3af",
    }}
  >
    <AlertTriangle size={40} color="#f87171" />
    <p style={{ fontSize: "14px", textAlign: "center", maxWidth: 280 }}>
      Could not load this page.
    </p>
    <p
      style={{
        fontSize: "11px",
        color: "#4b5563",
        maxWidth: 280,
        textAlign: "center",
      }}
    >
      {message}
    </p>
    <button onClick={onRetry} style={styles.retryBtn}>
      Try again
    </button>
  </div>
);

// ── Script injected into every proxied HTML page ──────────────────────────────
// IMPORTANT: This MUST use data: URL, NOT inline script!
// Inline scripts are blocked when CSP has sha256 hashes. new

function injectProxyScript(html: string): string {
  const overrideCode = `
  (function() {
    const DEBUG = true;
    function log(...args) { if (DEBUG) console.log('[Proxy]', ...args); }
    function warn(...args) { console.warn('[Proxy]', ...args); }

    log('Script injected');

    // Neutralize cookie access
    Object.defineProperty(document, 'cookie', {
      get: function() { return ''; },
      set: function() { /* no-op */ },
      configurable: false
    });

    let requestId = 0;
    const pending = new Map();

    function resolveUrl(url) {
      try {
        return new URL(url, document.baseURI).toString();
      } catch (e) {
        warn('Failed to resolve URL:', url, e);
        return url;
      }
    }

    function getSecFetchHeaders(url) {
        const parsed = new URL(url, document.baseURI);
        const sameOrigin = parsed.origin === window.location.origin;
        const destination = 'empty'; // Could be 'document', 'script', etc. We'll use 'empty' for XHR
        return {
            'Sec-Fetch-Site': sameOrigin ? 'same-origin' : 'cross-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-User': '?1'
        };
    }

    function proxyRequest(method, url, headers, body) {
      const absoluteUrl = resolveUrl(url);
      log('proxyRequest:', method, absoluteUrl);

        // Ensure headers is an array
        if (!Array.isArray(headers)) headers = [];

         // Add Instagram-specific headers
        if (absoluteUrl.includes('instagram.com')) {
            headers.push(['X-IG-App-ID', '936619743392459']);
            headers.push(['X-Requested-With', 'XMLHttpRequest']);
        }
        
        // Add Sec-Fetch-* headers (only if not already present)
        const secHeaders = getSecFetchHeaders(absoluteUrl);
        Object.entries(secHeaders).forEach(([k, v]) => {
            if (!headers.some(([name]) => name.toLowerCase() === k.toLowerCase())) {
            headers.push([k, v]);
            }
        });
        
        // Add Referer header
        headers.push(['Referer', window.location.href]);

      return new Promise((resolve, reject) => {
        const id = ++requestId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Request timeout"));
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        window.parent.postMessage({ type: "proxy-request", id, method, url: absoluteUrl, headers, body }, "*");
      });
    }

    function proxyResource(url) {
      const absoluteUrl = resolveUrl(url);
      log('proxyResource:', absoluteUrl);

        const headers = [];
        const secHeaders = getSecFetchHeaders(absoluteUrl);
        Object.entries(secHeaders).forEach(([k, v]) => {
            headers.push([k, v]);
        });
        headers.push(['Referer', window.location.href]);

      return new Promise((resolve, reject) => {
        const id = ++requestId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Resource timeout"));
        }, 30000);
        pending.set(id, { resolve, reject, timer, isResource: true });
        window.parent.postMessage({ type: "proxy-resource", id, url: absoluteUrl }, "*");
      });
    }

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "proxy-request-response") {
        const { id, error, status, statusText, headers, body, isBinary } = data;
        const pendingReq = pending.get(id);
        if (pendingReq) {
          clearTimeout(pendingReq.timer);
          pending.delete(id);
          if (error) {
            pendingReq.reject(new Error(error));
          } else {
            pendingReq.resolve({
              ok: status >= 200 && status < 300,
              status, statusText,
              headers: new Headers(headers),
              body: isBinary ? null : body,
              isBinary: isBinary,
            });
          }
        }
      } else if (data.type === "proxy-resource-response") {
        const { id, data: resourceData, contentType, ok } = data;
        const pendingReq = pending.get(id);
        if (pendingReq && pendingReq.isResource) {
          clearTimeout(pendingReq.timer);
          pending.delete(id);
          if (ok) {
            const dataUrl = 'data:' + contentType + ';base64,' + resourceData;
            pendingReq.resolve(dataUrl);
          } else {
            warn('Resource fetch failed');
            pendingReq.reject(new Error("Failed to fetch resource"));
          }
        }
      }
    });

    // Override fetch
    const originalFetch = window.fetch;
    window.fetch = function(input, init = {}) {
      let url = typeof input === 'string' ? input : input.url;
      const method = init.method || 'GET';
      const headers = init.headers || {};
      const body = init.body;
      const headerArray = [];
      if (headers instanceof Headers) {
        headers.forEach((v, k) => headerArray.push([k, v]));
      } else if (typeof headers === 'object') {
        Object.entries(headers).forEach(([k, v]) => headerArray.push([k, v]));
      }
      return proxyRequest(method, url, headerArray, body)
        .then(responseData => {
          const response = new Response(
            responseData.isBinary ? null : responseData.body,
            {
              status: responseData.status,
              statusText: responseData.statusText,
              headers: responseData.headers
            }
          );
          Object.defineProperty(response, 'ok', { value: responseData.ok });
          return response;
        });
    };

    // Override XHR
    const OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
      const xhr = new OriginalXHR();
      let method, url, async = true, requestHeaders = [], requestBody;
      let readyState = 0;
      let status = 0;
      let statusText = '';
      let responseHeaders = {};
      let responseBody = '';
      let onreadystatechange = null;
      let onload = null;
      let onerror = null;

      const updateReadyState = (newState) => {
        readyState = newState;
        if (onreadystatechange) onreadystatechange.call(xhr);
        if (readyState === 4 && onload) onload.call(xhr);
      };

      xhr.open = function(m, u, a) {
        method = m;
        url = u;
        async = a !== false;
      };
      xhr.setRequestHeader = function(name, value) {
        requestHeaders.push([name, value]);
      };
      xhr.send = function(body) {
        requestBody = body;
        if (!async) {
          console.warn("Synchronous XHR not supported in proxy mode");
        }
        proxyRequest(method, url, requestHeaders, requestBody)
          .then(resp => {
            status = resp.status;
            statusText = resp.statusText;
            responseHeaders = resp.headers;
            responseBody = resp.body;
            updateReadyState(4);
          })
          .catch(err => {
            if (onerror) onerror.call(xhr, err);
            updateReadyState(4);
          });
      };
      xhr.abort = function() {};
      Object.defineProperties(xhr, {
        readyState: { get: () => readyState },
        status: { get: () => status },
        statusText: { get: () => statusText },
        responseText: { get: () => responseBody },
        response: { get: () => responseBody },
        onreadystatechange: { set: (fn) => onreadystatechange = fn },
        onload: { set: (fn) => onload = fn },
        onerror: { set: (fn) => onerror = fn }
      });
      return xhr;
    };
    window.XMLHttpRequest.prototype = OriginalXHR.prototype;

       // ── Enhanced Resource Proxying ───────────────────────────────────────
    const processedElements = new WeakSet();

    async function fetchAndReplaceResource(element, attrName, originalUrl) {
      if (!originalUrl || originalUrl.startsWith('data:')) return;
      if (processedElements.has(element)) return;
      processedElements.add(element);

      log('Fetching resource for', element.tagName, attrName, originalUrl);
      try {
        const dataUrl = await proxyResource(originalUrl);
        if (element.loading) element.loading = 'eager';
        element.setAttribute(attrName, dataUrl);
        element.removeAttribute('data-original-' + attrName);
        if (element.tagName === 'IMG' || element.tagName === 'VIDEO') {
          element.dispatchEvent(new Event('load', { bubbles: true }));
        } else if (element.tagName === 'LINK' && element.rel === 'stylesheet') {
          element.disabled = false;
        }
      } catch (err) {
        warn('Failed to proxy resource:', originalUrl, err);
        element.setAttribute(attrName, originalUrl);
        element.removeAttribute('data-original-' + attrName);
      }
    }

    const ATTR_MAP = [
      ['img', 'src'], ['img', 'srcset'], ['source', 'src'], ['source', 'srcset'],
      ['video', 'src'], ['video', 'poster'], ['audio', 'src'],
      ['link', 'href'], ['script', 'src'], ['embed', 'src'], ['iframe', 'src'],
      ['object', 'data'], ['use', 'href'], ['image', 'href']
    ];

    function scanElementForResources(root) {
      if (root.nodeType !== Node.ELEMENT_NODE) return;

      const tag = root.tagName.toLowerCase();
      for (const [t, attr] of ATTR_MAP) {
        if (tag === t) {
          const originalAttr = 'data-original-' + attr;
          const originalUrl = root.getAttribute(originalAttr);
          if (originalUrl) {
            fetchAndReplaceResource(root, attr, originalUrl);
          }
        }
      }

      // Handle inline style url() safely with nongreedy match
      const style = root.getAttribute('style');
      if (style) {
        // Regex matches url("..."), url('...'), or url(...)
        const urlRegex = /url\\((["']?)(.*?)\\1\\)/g;
        let match;
        let newStyle = style;
        let changed = false;
        const promises = [];
        while ((match = urlRegex.exec(style)) !== null) {
          const quote = match[1];
          const originalUrl = match[2];
          const fullMatch = match[0];
          if (!originalUrl.startsWith('data:') && !originalUrl.startsWith('blob:')) {
            changed = true;
            const promise = proxyResource(originalUrl).then(dataUrl => {
              // Replace exactly the matched substring with the new data URL
              newStyle = newStyle.replace(fullMatch, 'url(' + quote + dataUrl + quote + ')');
            }).catch(() => {});
            promises.push(promise);
          }
        }
        if (changed) {
          Promise.all(promises).then(() => {
            root.setAttribute('style', newStyle);
          });
        }
      }

      for (const child of root.children) {
        scanElementForResources(child);
      }
    }

    function scanStyleElement(styleEl) {
      const content = styleEl.textContent;
      if (!content) return;
      const urlRegex = /url\\((["']?)(.*?)\\1\\)/g;
      let match;
      let newContent = content;
      let changed = false;
      const promises = [];
      while ((match = urlRegex.exec(content)) !== null) {
        const quote = match[1];
        const originalUrl = match[2];
        const fullMatch = match[0];
        if (!originalUrl.startsWith('data:')) {
          changed = true;
          const promise = proxyResource(originalUrl).then(dataUrl => {
            newContent = newContent.replace(fullMatch, 'url(' + quote + dataUrl + quote + ')');
          }).catch(() => {});
          promises.push(promise);
        }
      }
      if (changed) {
        Promise.all(promises).then(() => {
          styleEl.textContent = newContent;
        });
      }
    }

    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            scanElementForResources(node);
            if (node.tagName === 'STYLE') {
              scanStyleElement(node);
            }
          }
        }
        if (mut.type === 'attributes' && mut.attributeName === 'style') {
          scanElementForResources(mut.target);
        }
      }
    });

    function startObserving() {
      log('Starting resource scanner');
      document.querySelectorAll('style').forEach(scanStyleElement);
      scanElementForResources(document.body);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'src', 'srcset', 'href', 'poster', 'data'] });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserving);
    } else {
      startObserving();
    }

    document.addEventListener('click', (e) => {
      const anchor = e.target.closest('a[data-proxy-url]');
      if (!anchor) return;
      e.preventDefault();
      const url = anchor.getAttribute('data-proxy-url');
      if (url) window.parent.postMessage({ type: 'proxy-navigate', url }, '*');
    });

    log('All systems go');
  })();
`;

  const utf8Bytes = new TextEncoder().encode(overrideCode);
  const binaryString = Array.from(utf8Bytes, (byte) =>
    String.fromCharCode(byte),
  ).join("");
  const encoded = btoa(binaryString);
  const scriptTag = `<script src="data:text/javascript;base64,${encoded}"></script>`;

  // Insert into HTML (same as before)
  const lower = html.toLowerCase();
  const doctypePos = lower.indexOf("<!doctype html>");
  if (doctypePos !== -1) {
    const insertPos = doctypePos + "<!doctype html>".length;
    return html.slice(0, insertPos) + scriptTag + html.slice(insertPos);
  } else if (lower.indexOf("<html") !== -1) {
    const htmlTagPos = lower.indexOf("<html");
    return html.slice(0, htmlTagPos) + scriptTag + html.slice(htmlTagPos);
  } else {
    return scriptTag + html;
  }
}

function injectScrollbarStyles(html: string): string {
  const scrollbarCSS = `
    <style>
      /* Custom Scrollbar Styles for iframe content */
      html::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      
      html::-webkit-scrollbar-track {
        background: #1e1b4b;
        border-radius: 9999px;
        background-clip: padding-box;
      }
      
      html::-webkit-scrollbar-thumb {
        background: #14b8a6;
        border-radius: 9999px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      
      html::-webkit-scrollbar-thumb:hover {
        background: #22d3ee;
      }
      
      html::-webkit-scrollbar-corner {
        background: transparent;
      }
      
      /* Also apply to body for better coverage */
      body::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      
      body::-webkit-scrollbar-track {
        background: #1e1b4b;
        border-radius: 9999px;
        background-clip: padding-box;
      }
      
      body::-webkit-scrollbar-thumb {
        background: #14b8a6;
        border-radius: 9999px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      
      body::-webkit-scrollbar-thumb:hover {
        background: #22d3ee;
      }
    </style>
  `;

  // Insert the style tag into the HTML head
  const lowerHtml = html.toLowerCase();
  
  // Try to insert after <head> tag
  const headPos = lowerHtml.indexOf('<head');
  if (headPos !== -1) {
    const headEndPos = lowerHtml.indexOf('>', headPos);
    if (headEndPos !== -1) {
      return html.slice(0, headEndPos + 1) + scrollbarCSS + html.slice(headEndPos + 1);
    }
  }
  
  // Fallback: insert after <html> tag or at the beginning
  const htmlPos = lowerHtml.indexOf('<html');
  if (htmlPos !== -1) {
    const htmlEndPos = lowerHtml.indexOf('>', htmlPos);
    if (htmlEndPos !== -1) {
      return html.slice(0, htmlEndPos + 1) + scrollbarCSS + html.slice(htmlEndPos + 1);
    }
  }
  
  // Last resort: insert at the very beginning
  return scrollbarCSS + html;
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function displayHost(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== "/" ? u.pathname.slice(0, 30) : "");
  } catch {
    return url.slice(0, 40);
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  chromebox: {
    position: "absolute",
    bottom: "10%",
    left: 0,
    right: 0,
  } as React.CSSProperties,
  chrome: {
    position: "relative",
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.6rem 0.75rem",
    flexShrink: 0,
  } as React.CSSProperties,
  addressBar: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    background: "rgba(255, 255, 255, 0.1)", // Needs some background for backdrop-filter to work well
    backdropFilter: "blur(4px)", // Blurs what's behind the element
    borderRadius: "8px",
    padding: "0.3rem 0.65rem",
    gap: "0.4rem",
    overflow: "hidden",
  } as React.CSSProperties,
  addressInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "#e2e8f0",
    fontSize: "12px",
    fontFamily: "monospace",
    minWidth: 0,
  } as React.CSSProperties,
  loadingDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#a78bfa",
    flexShrink: 0,
  } as React.CSSProperties,
  closeBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "2rem",
    height: "2rem",
    borderRadius: "50%",
    border: "1px solid rgba(239, 68, 68, 0.2)",
    background: "rgba(239, 68, 68, 0.1)",
    backdropFilter: "blur(4px)", // Blurs what's behind the element
    color: "#f87171",
    cursor: "pointer",
    flexShrink: 0,
  } as React.CSSProperties,
  progressBar: {
    height: 2,
    background: "linear-gradient(90deg, #7c3aed, #a78bfa)",
    transformOrigin: "left center",
    flexShrink: 0,
  } as React.CSSProperties,
  retryBtn: {
    padding: "0.5rem 1.25rem",
    borderRadius: "8px",
    background: "rgba(168,85,247,0.2)",
    border: "1px solid rgba(168,85,247,0.4)",
    color: "#a78bfa",
    fontSize: "13px",
    cursor: "pointer",
  } as React.CSSProperties,
} as const;

const navBtn = (disabled: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "1.9rem",
  height: "1.9rem",
  borderRadius: "7px",
  background: "rgba(255, 255, 255, 0.1)",
  backdropFilter: "blur(4px)",
  color: disabled ? "#374151" : "#9ca3af",
  cursor: disabled ? "default" : "pointer",
  flexShrink: 0,
  transition: "color 0.15s",
  pointerEvents: disabled ? "none" : "auto",
});

export default InAppBrowser;
