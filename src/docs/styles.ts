/** Docs site stylesheet, served as a static asset. */
export const DOCS_CSS = `
:root {
  color-scheme: light;
  --bg: #F4F3EF;
  --surface: #FFFdf8;
  --surface-2: #EBE9E3;
  --surface-3: #E1DFD7;
  --topbar-bg: rgba(244, 243, 239, 0.92);
  --text: #111114;
  --text-muted: #3F3F46;
  --text-subtle: #6B6B73;
  --border: #D9D6CE;
  --border-strong: #C4C1B8;
  --primary: #8550FF;
  --primary-strong: #5C28C9;
  --primary-hover: #7038F5;
  --primary-soft: #EFE8FF;
  --code-bg: #FFFdf8;
  --code-border: #E1DFD7;
  --mark: #E4D4FF;
  --danger: #A32020;
  --warning: #8A5A00;
  --success: #0F7B4F;
  --shadow: 0 1px 2px rgba(17, 17, 20, 0.04), 0 8px 24px rgba(17, 17, 20, 0.05);
  --shadow-lg: 0 24px 64px rgba(17, 17, 20, 0.16);
  --scrim: rgba(17, 17, 20, 0.46);
  --focus: #8550FF;
  --on-primary: #ffffff;
  --radius: 10px;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #111114;
  --surface: #1A1A1F;
  --surface-2: #232329;
  --surface-3: #2C2C34;
  --topbar-bg: rgba(17, 17, 20, 0.92);
  --text: #F4F3EF;
  --text-muted: #C6C4BC;
  --text-subtle: #9A9890;
  --border: #2E2E36;
  --border-strong: #45454F;
  --primary: #8550FF;
  --primary-strong: #CDB6FF;
  --primary-hover: #9A6BFF;
  --primary-soft: #2A2144;
  --code-bg: #16161C;
  --code-border: #2E2E36;
  --mark: #4A3480;
  --danger: #FF8B8B;
  --warning: #E6B15A;
  --success: #5DCCA0;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 12px 32px rgba(0, 0, 0, 0.28);
  --shadow-lg: 0 24px 64px rgba(0, 0, 0, 0.55);
  --scrim: rgba(0, 0, 0, 0.62);
  --focus: #8550FF;
  --on-primary: #ffffff;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #111114;
    --surface: #1A1A1F;
    --surface-2: #232329;
    --surface-3: #2C2C34;
    --topbar-bg: rgba(17, 17, 20, 0.92);
    --text: #F4F3EF;
    --text-muted: #C6C4BC;
    --text-subtle: #9A9890;
    --border: #2E2E36;
    --border-strong: #45454F;
    --primary: #8550FF;
    --primary-strong: #CDB6FF;
    --primary-hover: #9A6BFF;
    --primary-soft: #2A2144;
    --code-bg: #16161C;
    --code-border: #2E2E36;
    --mark: #4A3480;
    --danger: #FF8B8B;
    --warning: #E6B15A;
    --success: #5DCCA0;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 12px 32px rgba(0, 0, 0, 0.28);
    --shadow-lg: 0 24px 64px rgba(0, 0, 0, 0.55);
    --scrim: rgba(0, 0, 0, 0.62);
    --focus: #8550FF;
    --on-primary: #ffffff;
  }
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { scroll-behavior: smooth; scroll-padding-top: 76px; }
body.search-open { overflow: hidden; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
::selection { background: var(--primary); color: var(--on-primary); }
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
button, input { font: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 200;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--primary);
  color: var(--on-primary);
  transform: translateY(-160%);
  transition: transform 120ms ease;
}
.skip-link:focus { transform: translateY(0); }

/* Top bar */
.topbar {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 14px;
  height: 56px;
  padding: 0 20px;
  border-bottom: 1px solid var(--border);
  background: var(--topbar-bg);
  backdrop-filter: blur(10px);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--text);
  font-weight: 700;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.brand:hover { text-decoration: none; }
.brand-logo,
.brand-logo-compact,
.brand-symbol-wrap {
  display: inline-flex;
  align-items: center;
  line-height: 0;
}
.brand-logo-compact { display: none; }
.brand-lockup { display: block; height: 26px; width: auto; }
.brand-symbol { display: block; width: 24px; height: 24px; }
.brand-lockup-dark,
.brand-symbol-dark { display: none; }
:root[data-theme="dark"] .brand-lockup-light,
:root[data-theme="dark"] .brand-symbol-light { display: none; }
:root[data-theme="dark"] .brand-lockup-dark,
:root[data-theme="dark"] .brand-symbol-dark { display: block; }
.brand-docs {
  margin-left: 2px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.topbar-spacer { flex: 1; }
.search-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 230px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 13px;
  text-align: left;
}
.search-trigger:hover { border-color: var(--border-strong); color: var(--text); }
.search-trigger svg { width: 15px; height: 15px; flex: none; }
.search-trigger kbd { margin-left: auto; }
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
}
.icon-button:hover { background: var(--surface-2); color: var(--text); }
.icon-button svg { width: 17px; height: 17px; }
.icon-sun,
.icon-moon { display: none; }
:root[data-theme="light"] .icon-sun { display: block; }
:root[data-theme="dark"] .icon-moon { display: block; }
.menu-button { display: none; }
kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-bottom-color: var(--border-strong);
  border-radius: 5px;
  background: var(--surface-2);
  color: var(--text-subtle);
  font-family: var(--sans);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}

/* Layout */
.layout {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr) 232px;
  max-width: 1440px;
  margin: 0 auto;
}
.layout:not(:has(.toc)) {
  grid-template-columns: 264px minmax(0, 1fr);
}
.sidebar {
  position: sticky;
  top: 56px;
  height: calc(100vh - 56px);
  overflow-y: auto;
  padding: 24px 14px 40px 20px;
  border-right: 1px solid var(--border);
  scrollbar-width: thin;
}
.sidebar-mobile-head { display: none; }
.nav-group { margin-bottom: 22px; }
.nav-group-label {
  display: block;
  margin: 0 10px 7px;
  color: var(--text-subtle);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.nav-link {
  display: block;
  padding: 6px 10px;
  border-radius: 7px;
  color: var(--text-muted);
  font-size: 13.5px;
  line-height: 1.45;
}
.nav-link:hover { background: var(--surface-2); color: var(--text); text-decoration: none; }
.nav-link.active {
  background: var(--primary-soft);
  color: var(--primary-strong);
  font-weight: 600;
}
.sidebar-footer {
  margin-top: 28px;
  padding: 14px 10px 0;
  border-top: 1px solid var(--border);
  color: var(--text-subtle);
  font-size: 12px;
}
.sidebar-footer a { color: var(--text-muted); }
.sidebar-footer .version { display: block; margin-top: 4px; }
.content {
  min-width: 0;
  padding: 38px 52px 88px;
}
.page { max-width: 780px; margin: 0 auto; }
.page:has(.hero-grid) { max-width: 1020px; }
.toc {
  position: sticky;
  top: 56px;
  height: calc(100vh - 56px);
  overflow-y: auto;
  padding: 40px 20px 40px 0;
  scrollbar-width: thin;
}
.toc-label {
  margin: 0 0 10px;
  color: var(--text-subtle);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.toc-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.toc-link {
  display: block;
  padding: 4px 0;
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.45;
}
.toc-link:hover { color: var(--text); text-decoration: none; }
.toc-link.depth-3 { padding-left: 12px; font-size: 12px; }
.toc-link.active { color: var(--primary-strong); font-weight: 600; }

/* Breadcrumbs and page chrome */
.breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-bottom: 22px;
  color: var(--text-subtle);
  font-size: 12.5px;
}
.breadcrumbs a { color: var(--text-muted); }
.breadcrumbs .sep { color: var(--border-strong); }
.page-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.page-kicker {
  color: var(--primary-strong);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.page-nav {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 56px;
  padding-top: 22px;
  border-top: 1px solid var(--border);
}
.page-nav-link {
  display: block;
  padding: 13px 15px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
}
.page-nav-link:hover { border-color: var(--border-strong); text-decoration: none; }
.page-nav-link.next { text-align: right; }
.page-nav-label { display: block; color: var(--text-subtle); font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.page-nav-title { display: block; margin-top: 3px; font-size: 14px; font-weight: 600; }
.page-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 24px;
  color: var(--text-subtle);
  font-size: 12.5px;
}
.page-footer a { color: var(--text-muted); }

/* Markdown */
.markdown-body { font-size: 15px; line-height: 1.72; }
.markdown-body > :first-child { margin-top: 0; }
.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4 {
  position: relative;
  margin: 2.2em 0 0.65em;
  color: var(--text);
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1.25;
}
.markdown-body h1 { margin-top: 0; font-size: 2.15rem; letter-spacing: -0.025em; }
.markdown-body h2 { padding-bottom: 0.35rem; border-bottom: 1px solid var(--border); font-size: 1.45rem; }
.markdown-body h3 { font-size: 1.15rem; }
.markdown-body h4 { font-size: 1rem; }
.markdown-body p { margin: 0.9em 0; }
.markdown-body ul,
.markdown-body ol { margin: 0.9em 0; padding-left: 1.45rem; }
.markdown-body li { margin: 0.32em 0; }
.markdown-body li > p { margin: 0.35em 0; }
.markdown-body strong { color: var(--text); font-weight: 650; }
.markdown-body hr { height: 1px; margin: 2.4em 0; border: 0; background: var(--border); }
.markdown-body blockquote {
  margin: 1.3em 0;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-muted);
}
.markdown-body blockquote > :first-child { margin-top: 0; }
.markdown-body blockquote > :last-child { margin-bottom: 0; }
.callout {
  margin: 1.3em 0;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.callout > :last-child { margin-bottom: 0; }
.callout-title {
  margin: 0 0 6px;
  color: var(--text);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.callout-warning { background: color-mix(in srgb, var(--warning) 8%, var(--surface)); }
.callout-caution { background: color-mix(in srgb, var(--danger) 8%, var(--surface)); }
.markdown-body :not(pre) > code {
  padding: 0.16em 0.38em;
  border: 1px solid var(--code-border);
  border-radius: 5px;
  background: var(--code-bg);
  color: var(--text);
  font-family: var(--mono);
  font-size: 0.86em;
  white-space: break-spaces;
}
.heading-anchor {
  margin-left: 8px;
  color: var(--text-subtle);
  font-weight: 500;
  opacity: 0;
  transition: opacity 120ms ease;
}
.markdown-body h1:hover .heading-anchor,
.markdown-body h2:hover .heading-anchor,
.markdown-body h3:hover .heading-anchor,
.markdown-body h4:hover .heading-anchor,
.heading-anchor:focus-visible { opacity: 1; }
.heading-anchor:hover { color: var(--primary); text-decoration: none; }
.table-wrap {
  margin: 1.2em 0;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.markdown-body table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.markdown-body th,
.markdown-body td { padding: 9px 12px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.markdown-body th { background: var(--surface-2); color: var(--text); font-weight: 650; white-space: nowrap; }
.markdown-body tbody tr:last-child td { border-bottom: 0; }
.markdown-body tbody tr:hover { background: var(--surface-2); }
.markdown-body img { max-width: 100%; height: auto; border-radius: var(--radius); }

/* Code blocks */
.code-block {
  margin: 1.25em 0;
  overflow: hidden;
  border: 1px solid var(--code-border);
  border-radius: var(--radius);
  background: var(--code-bg);
}
.code-block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  min-height: 38px;
  border-bottom: 1px solid var(--code-border);
  background: var(--surface-2);
}
.pm-switch {
  display: flex;
  align-items: stretch;
  gap: 2px;
  min-width: 0;
  align-self: stretch;
}
.pm-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 0 9px;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: transparent;
  color: var(--text-subtle);
  font-size: 12px;
  font-weight: 600;
  transition: color 120ms ease, border-color 120ms ease;
}
.pm-tab:hover { color: var(--text); }
.pm-tab[aria-selected="true"] {
  color: var(--text);
  border-bottom-color: var(--primary);
}
.code-block-lang {
  color: var(--text-subtle);
  font-family: var(--sans);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.code-copy {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  color: var(--text-muted);
  font-size: 11.5px;
  font-weight: 600;
}
.code-copy:hover { border-color: var(--border-strong); color: var(--text); }
.code-copy.copied { border-color: var(--success); color: var(--success); }
.shiki,
.shiki-fallback {
  margin: 0 !important;
  padding: 15px 17px !important;
  overflow-x: auto;
  background: var(--code-bg) !important;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.65;
  tab-size: 2;
}
.shiki code,
.shiki-fallback code { font-family: var(--mono); }
.shiki span { color: var(--shiki-light); }
:root[data-theme="dark"] .shiki span { color: var(--shiki-dark); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .shiki span { color: var(--shiki-dark); }
  :root:not([data-theme="light"]) .brand-lockup-light,
  :root:not([data-theme="light"]) .brand-symbol-light { display: none; }
  :root:not([data-theme="light"]) .brand-lockup-dark,
  :root:not([data-theme="light"]) .brand-symbol-dark { display: block; }
}
.shiki-fallback code { color: var(--text); }
.shiki-fallback { white-space: pre; }

/* Landing */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.08fr);
  align-items: center;
  gap: 32px 44px;
  padding: 18px 0 42px;
  border-bottom: 1px solid var(--border);
}
.hero-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
}
.docs-lockup { margin: 0; line-height: 0; }
.hero-copy .brand-lockup { height: 46px; }
.hero-lead {
  max-width: 34ch;
  margin: 18px 0 0;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1.55;
}
.hero-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
.install-card {
  width: 100%;
  max-width: 380px;
  margin-top: 22px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--code-bg);
}
.install-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 36px;
  padding: 0 10px 0 6px;
  border-bottom: 1px solid var(--code-border);
  background: var(--surface-2);
}
.install-card-body {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 13.5px;
  line-height: 1.4;
}
.install-prompt {
  color: var(--primary);
  font-weight: 700;
  user-select: none;
}
.install-card-body code {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--text);
  font-family: var(--mono);
  white-space: nowrap;
}
.hero-specimen {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--code-bg);
  box-shadow: var(--shadow);
}
.specimen-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 40px;
  padding: 0 10px 0 8px;
  border-bottom: 1px solid var(--code-border);
  background: var(--surface-2);
}
.specimen-tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  align-self: stretch;
}
.specimen-tab {
  display: inline-flex;
  align-items: center;
  padding: 0 11px;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: transparent;
  color: var(--text-subtle);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 500;
  transition: color 120ms ease, border-color 120ms ease;
}
.specimen-tab:hover { color: var(--text); }
.specimen-tab[aria-selected="true"] {
  color: var(--text);
  border-bottom-color: var(--primary);
}
.specimen-body {
  display: grid;
}
.specimen-panel {
  grid-area: 1 / 1;
  min-width: 0;
}
.specimen-panel[data-active="false"] {
  visibility: hidden;
  pointer-events: none;
  user-select: none;
}
.specimen-body .shiki,
.specimen-body .shiki-fallback {
  height: 100%;
  padding: 16px 18px !important;
  font-size: 12.5px;
  line-height: 1.62;
}
.specimen-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-top: 1px solid var(--code-border);
  background: var(--surface-2);
}
.specimen-dialect {
  padding: 4px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-subtle);
  font-size: 11.5px;
  font-weight: 600;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.specimen-dialect:hover { color: var(--text); }
.hero-specimen[data-active-tab="sql"] .specimen-dialect[aria-pressed="true"] {
  border-color: var(--primary-border);
  background: var(--primary-soft);
  color: var(--primary);
}
.hero-specimen:not([data-active-tab="sql"]) .specimen-dialect[aria-pressed="true"] {
  color: var(--text-muted);
}
.button svg { width: 16px; height: 16px; flex: none; }
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 38px;
  padding: 0 15px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 13.5px;
  font-weight: 600;
}
.button:hover { border-color: var(--border-strong); text-decoration: none; }
.button.primary { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }
.button.primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); color: var(--on-primary); }
.section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin: 38px 0 14px;
}
.section-heading h2 { margin: 0; font-size: 1.15rem; letter-spacing: -0.01em; }
.section-heading p { margin: 0; color: var(--text-subtle); font-size: 12.5px; }
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 15px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
}
.card:hover { border-color: var(--border-strong); box-shadow: var(--shadow); text-decoration: none; }
.card-title { font-size: 14px; font-weight: 650; }
.card-description { color: var(--text-muted); font-size: 12.5px; line-height: 1.5; }

/* Search */
.search-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: center;
  padding: 10vh 20px 20px;
  background: var(--scrim);
  backdrop-filter: blur(4px);
}
.search-dialog {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 660px;
  max-height: 70vh;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}
.search-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.search-input-row svg { width: 18px; height: 18px; flex: none; color: var(--text-subtle); }
.search-close { display: none; flex: none; }
.search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 16px;
}
.search-input::placeholder { color: var(--text-subtle); }
.search-body { flex: 1; overflow-y: auto; padding: 6px; }
.search-hint { padding: 22px 16px; color: var(--text-muted); font-size: 13px; text-align: center; }
.search-group-label {
  padding: 8px 10px 4px;
  color: var(--text-subtle);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.search-result {
  display: block;
  padding: 9px 10px;
  border-radius: 7px;
  color: var(--text);
}
.search-result:hover,
.search-result.active { background: var(--surface-2); text-decoration: none; }
.search-result-title { display: flex; align-items: baseline; gap: 8px; font-size: 13.5px; font-weight: 650; }
.search-result-page { color: var(--text-subtle); font-size: 11.5px; font-weight: 500; }
.search-result-excerpt { margin-top: 2px; color: var(--text-muted); font-size: 12.5px; line-height: 1.45; }
.search-result-excerpt mark { padding: 0 1px; border-radius: 3px; background: var(--mark); color: inherit; }
.search-empty { padding: 28px 16px; text-align: center; }
.search-empty-title { font-size: 14px; font-weight: 650; }
.search-empty-text { margin-top: 4px; color: var(--text-muted); font-size: 12.5px; }
.search-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  color: var(--text-subtle);
  font-size: 11.5px;
}
.search-footer-keys { display: flex; align-items: center; gap: 5px; }

/* 404 */
.not-found { max-width: 620px; margin: 8vh auto 0; text-align: center; }
.not-found-code { color: var(--primary); font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: 0.08em; }
.not-found h1 { margin: 10px 0 8px; font-size: 2rem; letter-spacing: -0.03em; }
.not-found p { margin: 0 auto 22px; color: var(--text-muted); }

/* Mobile nav */
.nav-backdrop { display: none; }
@media (max-width: 1200px) {
  .layout,
  .layout:not(:has(.toc)) { grid-template-columns: 250px minmax(0, 1fr); }
  .toc { display: none; }
  .content { padding: 34px 40px 80px; }
}
@media (max-width: 900px) {
  .layout,
  .layout:not(:has(.toc)) { grid-template-columns: minmax(0, 1fr); }
  .content { padding: 28px 22px 72px; }
  .menu-button { display: inline-flex; }
  .search-trigger { min-width: 0; width: 34px; padding: 0; justify-content: center; }
  .search-trigger span,
  .search-trigger kbd { display: none; }
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 90;
    width: min(310px, 86vw);
    height: 100vh;
    padding: 18px 14px 32px;
    border-right: 1px solid var(--border);
    background: var(--surface);
    transform: translateX(-102%);
    transition: transform 180ms ease;
  }
  body.nav-open .sidebar { transform: translateX(0); }
  body.nav-open .nav-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 80;
    background: var(--scrim);
    backdrop-filter: blur(2px);
  }
  .sidebar-mobile-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
    padding: 0 4px 14px;
    border-bottom: 1px solid var(--border);
  }
  .search-overlay { padding: 0; }
  .search-dialog { max-width: none; max-height: none; height: 100%; border: 0; border-radius: 0; }
  .search-esc { display: none; }
  .search-close { display: inline-flex; }
  .search-footer { padding-bottom: 14px; }
  .page-nav { grid-template-columns: 1fr; }
  .page-nav-link.next { text-align: left; }
}
@media (max-width: 1020px) {
  .hero-grid { grid-template-columns: 1fr; gap: 28px; padding: 10px 0 34px; }
  .install-card { max-width: 420px; }
}
@media (max-width: 560px) {
  .topbar { padding: 0 12px; gap: 8px; }
  .brand-docs { display: none; }
  .brand > .brand-logo { display: none; }
  .brand > .brand-logo-compact { display: inline-flex; }
  .content { padding: 24px 16px 64px; }
  .markdown-body h1 { font-size: 1.8rem; }
  .markdown-body h2 { font-size: 1.3rem; }
  .hero-copy .brand-lockup { height: 36px; }
  .install-card { max-width: none; }
  .card-grid { grid-template-columns: 1fr; }
  .page-footer { flex-direction: column; align-items: flex-start; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}

@media print {
  .topbar, .sidebar, .toc, .search-overlay, .page-nav, .page-footer, .skip-link { display: none !important; }
  .layout { display: block; }
  .content { padding: 0; }
  .page { max-width: none; }
  body { background: #ffffff; color: #000000; }
  .markdown-body a { color: #000000; text-decoration: underline; }
  .code-block { break-inside: avoid; }
}
`;
