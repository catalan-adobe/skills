# Layout Patterns

Common app shell patterns for Spectrum 2 Web Components with complete runnable examples.

## Table of Contents

- [Pattern 1: Sidebar + Main](#pattern-1-sidebar--main)
- [Pattern 2: Top Nav + Content](#pattern-2-top-nav--content)
- [Pattern 3: Dashboard](#pattern-3-dashboard)
- [Pattern 4: Form Page](#pattern-4-form-page)
- [Pattern 5: Settings Panel](#pattern-5-settings-panel)

All examples use the CDN bundle:
```html
<script src="https://jspm.dev/@spectrum-web-components/bundle/elements.js" type="module" async></script>
```

---

## Pattern 1: Sidebar + Main

**When to use:** Settings pages, admin panels, documentation sites — any app with a fixed navigation
hierarchy on the left and a large content area on the right.

**Components:** `sp-sidenav`, `sp-sidenav-item`, `sp-sidenav-heading`

**Layout:** CSS Grid `grid-template-columns: 240px 1fr`

**Key tokens:**
- Gap between sidebar and content: `--spectrum-spacing-400` (32px)
- Sidebar internal padding: `--spectrum-spacing-300` (24px)

**Responsive:** Collapse sidebar at `max-width: 768px` — move nav to a top drawer or hamburger menu.

```html
<!-- Use CDN setup from top of file -->
<style>
  body { margin: 0; font-family: adobe-clean, sans-serif; }
  .app {
    display: grid;
    grid-template-columns: 240px 1fr;
    min-height: 100vh;
  }
  .sidebar {
    border-right: 1px solid var(--spectrum-gray-200);
    padding: var(--spectrum-spacing-300);
    background: var(--spectrum-gray-50);
  }
  .sidebar h2 {
    margin: 0 0 var(--spectrum-spacing-300);
    font-size: var(--spectrum-font-size-200);
    color: var(--spectrum-gray-900);
  }
  .main {
    padding: var(--spectrum-spacing-400);
  }
  @media (max-width: 768px) {
    .app { grid-template-columns: 1fr; }
    .sidebar { border-right: none; border-bottom: 1px solid var(--spectrum-gray-200); }
  }
</style>
<sp-theme system="spectrum-two" color="light" scale="medium">
  <div class="app">
    <nav class="sidebar">
      <h2>My App</h2>
      <sp-sidenav>
        <sp-sidenav-heading label="General">
          <sp-sidenav-item value="overview" label="Overview" selected></sp-sidenav-item>
          <sp-sidenav-item value="profile" label="Profile"></sp-sidenav-item>
        </sp-sidenav-heading>
        <sp-sidenav-heading label="Settings">
          <sp-sidenav-item value="account" label="Account"></sp-sidenav-item>
          <sp-sidenav-item value="security" label="Security"></sp-sidenav-item>
        </sp-sidenav-heading>
      </sp-sidenav>
    </nav>
    <main class="main">
      <h1 style="margin-top:0">Overview</h1>
      <p>Main content area. Select a navigation item on the left to switch sections.</p>
    </main>
  </div>
</sp-theme>
```

---

## Pattern 2: Top Nav + Content

**When to use:** Public-facing apps, simple tool UIs, single-level navigation without deep hierarchy.

**Components:** `sp-top-nav`, `sp-top-nav-item`

**Layout:** Full-width sticky header + scrollable main content below.

**Key tokens:**
- Nav height is set by `sp-top-nav` internals (~48px at medium scale)
- Content padding: `--spectrum-spacing-400`

```html
<!-- Use CDN setup from top of file -->
<style>
  body { margin: 0; font-family: adobe-clean, sans-serif; }
  sp-top-nav { position: sticky; top: 0; z-index: 10; }
  .content {
    max-width: 960px;
    margin: 0 auto;
    padding: var(--spectrum-spacing-400);
  }
</style>
<sp-theme system="spectrum-two" color="light" scale="medium">
  <sp-top-nav>
    <sp-top-nav-item href="#">Home</sp-top-nav-item>
    <sp-top-nav-item href="#" selected>Projects</sp-top-nav-item>
    <sp-top-nav-item href="#">Team</sp-top-nav-item>
    <sp-top-nav-item href="#">Settings</sp-top-nav-item>
    <sp-top-nav-item slot="action" href="#">Sign in</sp-top-nav-item>
  </sp-top-nav>
  <main class="content">
    <h1 style="margin-top:0">Projects</h1>
    <p>Page content goes here. The nav stays pinned to the top as you scroll.</p>
  </main>
</sp-theme>
```

---

## Pattern 3: Dashboard

**When to use:** Analytics pages, monitoring dashboards, status overviews — anywhere you display
multiple KPIs or data summaries in a scannable grid.

**Components:** `sp-card`, `sp-meter`, `sp-status-light`, `sp-progress-bar`, `sp-badge`

**Layout:** CSS Grid `repeat(auto-fit, minmax(280px, 1fr))` — cards reflow automatically.

**Key tokens:**
- Card gap: `--spectrum-spacing-300`
- Card internal padding: `--spectrum-spacing-300`

```html
<!-- Use CDN setup from top of file -->
<style>
  body { margin: 0; font-family: adobe-clean, sans-serif; background: var(--spectrum-gray-100); }
  .dashboard {
    padding: var(--spectrum-spacing-400);
  }
  .dashboard h1 { margin-top: 0; }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: var(--spectrum-spacing-300);
  }
  .card-body {
    padding: var(--spectrum-spacing-300);
    display: flex;
    flex-direction: column;
    gap: var(--spectrum-spacing-200);
  }
  .card-stat {
    font-size: var(--spectrum-font-size-500);
    font-weight: bold;
    color: var(--spectrum-gray-900);
  }
  .card-label {
    font-size: var(--spectrum-font-size-75);
    color: var(--spectrum-gray-700);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .status-row {
    display: flex;
    align-items: center;
    gap: var(--spectrum-spacing-100);
  }
</style>
<sp-theme system="spectrum-two" color="light" scale="medium">
  <div class="dashboard">
    <h1>System Dashboard</h1>
    <div class="cards">

      <sp-card>
        <div slot="heading">Storage</div>
        <div class="card-body" slot="description">
          <div class="card-stat">72 GB</div>
          <div class="card-label">of 100 GB used</div>
          <sp-meter value="72" max="100" variant="warning" label="Storage used"></sp-meter>
        </div>
      </sp-card>

      <sp-card>
        <div slot="heading">Services</div>
        <div class="card-body" slot="description">
          <div class="status-row">
            <sp-status-light variant="positive">API Gateway</sp-status-light>
          </div>
          <div class="status-row">
            <sp-status-light variant="positive">Database</sp-status-light>
          </div>
          <div class="status-row">
            <sp-status-light variant="notice">CDN</sp-status-light>
          </div>
          <div class="status-row">
            <sp-status-light variant="negative">Queue Worker</sp-status-light>
          </div>
        </div>
      </sp-card>

      <sp-card>
        <div slot="heading">Active Jobs</div>
        <div class="card-body" slot="description">
          <div class="card-stat">14</div>
          <div class="card-label">running now</div>
          <sp-progress-bar value="60" label="Queue throughput"></sp-progress-bar>
          <div style="display:flex; gap: var(--spectrum-spacing-100); flex-wrap: wrap;">
            <sp-badge variant="informative">8 export</sp-badge>
            <sp-badge variant="positive">4 import</sp-badge>
            <sp-badge variant="notice">2 pending</sp-badge>
          </div>
        </div>
      </sp-card>

      <sp-card>
        <div slot="heading">Error Rate</div>
        <div class="card-body" slot="description">
          <div class="card-stat">0.3%</div>
          <div class="card-label">last 24 hours</div>
          <sp-meter value="0.3" max="5" variant="positive" label="Error rate"></sp-meter>
        </div>
      </sp-card>

    </div>
  </div>
</sp-theme>
```

---

## Pattern 4: Form Page

**When to use:** Data entry, registration flows, onboarding wizards, any workflow that collects
structured input from the user.

**Components:** `sp-field-label`, `sp-textfield`, `sp-help-text`, `sp-picker`, `sp-menu-item`,
`sp-checkbox`, `sp-button`

**Layout:** Vertical stack, `max-width: 600px`, centered. Button row pinned at the bottom of the
form with cancel on the left and submit on the right.

**Stacking order (always):** `sp-field-label` → field element → `sp-help-text`

**Key tokens:**
- Gap between fields: `--spectrum-spacing-400`
- Gap inside button row: `--spectrum-spacing-200`

```html
<!-- Use CDN setup from top of file -->
<style>
  body { margin: 0; font-family: adobe-clean, sans-serif; background: var(--spectrum-gray-100); }
  .page {
    max-width: 600px;
    margin: 0 auto;
    padding: var(--spectrum-spacing-400);
  }
  .page h1 { margin-top: 0; }
  form {
    background: var(--spectrum-gray-50);
    border: 1px solid var(--spectrum-gray-200);
    border-radius: var(--spectrum-corner-radius-100);
    padding: var(--spectrum-spacing-400);
    display: flex;
    flex-direction: column;
    gap: var(--spectrum-spacing-400);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--spectrum-spacing-75);
  }
  .button-row {
    display: flex;
    justify-content: flex-end;
    gap: var(--spectrum-spacing-200);
    padding-top: var(--spectrum-spacing-200);
    border-top: 1px solid var(--spectrum-gray-200);
  }
</style>
<sp-theme system="spectrum-two" color="light" scale="medium">
  <div class="page">
    <h1>Create Project</h1>
    <form>

      <div class="field">
        <sp-field-label for="proj-name" required>Project name</sp-field-label>
        <sp-textfield id="proj-name" placeholder="e.g. Q2 Campaign" required></sp-textfield>
        <sp-help-text>Use a short, descriptive name for this project.</sp-help-text>
      </div>

      <div class="field">
        <sp-field-label for="region">Region</sp-field-label>
        <sp-picker id="region" label="Select region">
          <sp-menu-item value="us-west">US West</sp-menu-item>
          <sp-menu-item value="us-east">US East</sp-menu-item>
          <sp-menu-item value="eu-west">EU West</sp-menu-item>
          <sp-menu-item value="ap-south">AP South</sp-menu-item>
        </sp-picker>
        <sp-help-text>Choose the data residency region for this project.</sp-help-text>
      </div>

      <div class="field">
        <sp-field-label for="description">Description</sp-field-label>
        <sp-textfield id="description" multiline rows="3"
          placeholder="What is this project for?"></sp-textfield>
        <sp-help-text>Optional. Visible to all project members.</sp-help-text>
      </div>

      <sp-checkbox>Notify team members when project is created</sp-checkbox>

      <div class="button-row">
        <sp-button variant="secondary" treatment="outline">Cancel</sp-button>
        <sp-button variant="accent">Create project</sp-button>
      </div>

    </form>
  </div>
</sp-theme>
```

---

## Pattern 5: Settings Panel

**When to use:** Admin or preferences screens with nested categories — too deep for tabs alone but
too flat for a full page router. Combines a left sidenav (category selection) with tabbed
sub-sections in the main area.

**Components:** `sp-sidenav`, `sp-sidenav-item`, `sp-tabs`, `sp-tab`, `sp-tab-panel`,
`sp-field-label`, `sp-textfield`, `sp-switch`, `sp-button`

**Layout:** CSS Grid sidebar + tabbed main (Patterns 1 and 4 composed together).

**Key tokens:**
- Column split: `220px 1fr`
- Tab panel padding: `--spectrum-spacing-400`

```html
<!-- Use CDN setup from top of file -->
<style>
  body { margin: 0; font-family: adobe-clean, sans-serif; }
  .settings {
    display: grid;
    grid-template-columns: 220px 1fr;
    min-height: 100vh;
  }
  .settings-sidebar {
    border-right: 1px solid var(--spectrum-gray-200);
    padding: var(--spectrum-spacing-300);
    background: var(--spectrum-gray-50);
  }
  .settings-sidebar h2 {
    margin: 0 0 var(--spectrum-spacing-300);
    font-size: var(--spectrum-font-size-200);
    color: var(--spectrum-gray-900);
  }
  .settings-main {
    padding: var(--spectrum-spacing-400);
  }
  .settings-main h1 {
    margin-top: 0;
    font-size: var(--spectrum-font-size-400);
  }
  sp-tab-panel {
    display: flex;
    flex-direction: column;
    gap: var(--spectrum-spacing-400);
    padding-top: var(--spectrum-spacing-400);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--spectrum-spacing-75);
    max-width: 480px;
  }
  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    max-width: 480px;
    padding: var(--spectrum-spacing-200) 0;
    border-bottom: 1px solid var(--spectrum-gray-200);
  }
  .switch-label {
    font-size: var(--spectrum-font-size-100);
    color: var(--spectrum-gray-800);
  }
  .button-row {
    display: flex;
    gap: var(--spectrum-spacing-200);
    padding-top: var(--spectrum-spacing-200);
  }
  @media (max-width: 700px) {
    .settings { grid-template-columns: 1fr; }
    .settings-sidebar { border-right: none; border-bottom: 1px solid var(--spectrum-gray-200); }
  }
</style>
<sp-theme system="spectrum-two" color="light" scale="medium">
  <div class="settings">

    <nav class="settings-sidebar">
      <h2>Settings</h2>
      <sp-sidenav>
        <sp-sidenav-item value="account" label="Account" selected></sp-sidenav-item>
        <sp-sidenav-item value="notifications" label="Notifications"></sp-sidenav-item>
        <sp-sidenav-item value="billing" label="Billing"></sp-sidenav-item>
        <sp-sidenav-item value="integrations" label="Integrations"></sp-sidenav-item>
      </sp-sidenav>
    </nav>

    <main class="settings-main">
      <h1>Account</h1>
      <sp-tabs selected="profile">
        <sp-tab value="profile" label="Profile"></sp-tab>
        <sp-tab value="security" label="Security"></sp-tab>
        <sp-tab value="preferences" label="Preferences"></sp-tab>

        <sp-tab-panel value="profile">
          <div class="field">
            <sp-field-label for="display-name">Display name</sp-field-label>
            <sp-textfield id="display-name" value="Alex Rivera"></sp-textfield>
            <sp-help-text>Shown to teammates and in exported reports.</sp-help-text>
          </div>
          <div class="field">
            <sp-field-label for="email">Email address</sp-field-label>
            <sp-textfield id="email" type="email" value="alex@example.com"></sp-textfield>
            <sp-help-text>Used for account recovery and notifications.</sp-help-text>
          </div>
          <div class="button-row">
            <sp-button variant="secondary" treatment="outline">Cancel</sp-button>
            <sp-button variant="accent">Save changes</sp-button>
          </div>
        </sp-tab-panel>

        <sp-tab-panel value="security">
          <div class="switch-row">
            <span class="switch-label">Two-factor authentication</span>
            <sp-switch checked></sp-switch>
          </div>
          <div class="switch-row">
            <span class="switch-label">Login alerts by email</span>
            <sp-switch></sp-switch>
          </div>
          <div class="switch-row">
            <span class="switch-label">Active session notifications</span>
            <sp-switch checked></sp-switch>
          </div>
          <div class="button-row">
            <sp-button variant="accent">Save changes</sp-button>
          </div>
        </sp-tab-panel>

        <sp-tab-panel value="preferences">
          <div class="switch-row">
            <span class="switch-label">Compact density</span>
            <sp-switch></sp-switch>
          </div>
          <div class="switch-row">
            <span class="switch-label">Show keyboard shortcuts</span>
            <sp-switch checked></sp-switch>
          </div>
          <div class="button-row">
            <sp-button variant="accent">Save changes</sp-button>
          </div>
        </sp-tab-panel>
      </sp-tabs>
    </main>

  </div>
</sp-theme>
```
