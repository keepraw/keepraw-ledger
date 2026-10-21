# Production Content Security Policy

The production Vite build injects an enforcing `Content-Security-Policy` meta
before all scripts, modulepreloads and stylesheets. The development server does
not receive this policy because Vite HMR requires development script/style
injection. `npm run test:e2e` runs the existing development-server tests, then
builds and serves the production artifact on a separate port for CSP tests.

```text
default-src 'none'; script-src 'self'; script-src-attr 'none';
connect-src 'self'; worker-src 'self'; style-src 'self';
style-src-attr 'unsafe-inline'; img-src 'self'; font-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none'
```

- Vite entry points, lazy PDF.js/PostalMime/SheetJS chunks, styles and the PDF.js
  module Worker are served from the same origin. Same-origin connections remain
  available for local asset retrieval; no bank, CDN, analytics or API origin is
  allowlisted. Dependency downloads during installation are not runtime origins.
- React uses style attributes for chart dimensions, import progress and layout.
  Only `style-src-attr` permits inline styles. Inline `<style>` elements,
  inline scripts/handlers, eval and external styles/scripts remain blocked in
  supported CSP3 browsers. Older browsers without this directive may lose the
  dynamic styles; they are not certified by the Chromium tests.
- Blob URLs are used for user-initiated CSV/XLSX/JSON/ZIP/original-file downloads.
  They do not require adding `blob:` to script, connect or Worker source lists.
  Blob/data scripts and Blob Workers are deliberately disallowed. No external
  fonts, images, frames, objects, media or form submissions are required.
- PDF.js still receives `isEvalSupported: false`, `useSystemFonts: false` and
  `disableFontFace: true`. The browser test observes an actual same-origin
  `/assets/pdf.worker.min-*.mjs` Worker and successfully imports a synthetic PDF;
  it does not accept a fake-worker-only fallback as proof.

## Hosting and security boundaries

GitHub Pages publishes static artifacts through `.github/workflows/ci.yml`.
The inspected workflow/Pages configuration exposes no custom HTTP response-header
configuration. A `_headers` file is not a GitHub Pages response-header mechanism
and is not added. The live HTTPS response inspected on 2026-10-21 had neither a
CSP response header nor a meta policy; this PR requires merge and the normal main
Pages deployment before the new HTML reaches production.

Meta CSP is useful defense in depth, **not equivalent to an HTTP CSP header**:

- It starts when the browser parses the meta. It cannot protect content before
  that point, response metadata, redirects, error pages or other documents.
- `frame-ancestors`, `sandbox` and `report-uri` cannot be enforced through meta.
  Anti-framing, response-level sandboxing, Report-Only rollout and reliable
  HTTP-configured reporting remain outside this change. `default-src 'none'`
  blocks child frames, but does not prevent another site framing this document.
- A same-origin external Worker's own execution/network policy comes from its
  response headers, not the document meta. `worker-src 'self'` restricts Worker
  creation; it does not install CSP inside that Worker. PDF.js's explicit eval
  disabling is a separate application control.
- Same-origin scripts/connections are still trusted. This policy does not defend
  against a compromised allowed asset, arbitrary same-origin code, browser
  extensions, device compromise or downloads already outside the application.
  It is not a general network firewall or a guarantee that no data can leave.
- HTTPS enforcement, HSTS and other response headers require hosting/edge
  controls. Pages API returned `https_enforced: false` at inspection; the tested
  HTTPS URL worked. This is a configuration observation, not proof of an exploit.

Full response-header protection would require supported hosting/edge controls,
followed by renewed browser and deployment tests. No hosting migration or
production configuration change is performed by this PR.

References: [GitHub Pages static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages),
[WHATWG meta CSP](https://html.spec.whatwg.org/multipage/semantics.html#attr-meta-http-equiv-content-security-policy),
[W3C CSP meta delivery](https://www.w3.org/TR/CSP3/#meta-element),
[Worker CSP behavior](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers#content_security_policy).
