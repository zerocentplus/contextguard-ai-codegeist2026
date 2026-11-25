# ContextGuard AI — Engineering Context & Release Readiness Copilot

> **Codegeist 2026 submission** — *Apps for Software Teams* track + *Best Rovo Agent* bonus prize

ContextGuard AI is a production-ready Atlassian Forge app that acts as an intelligent co-pilot for engineering teams. It automatically reads Jira issue and Confluence page context, computes a **Context Readiness Score**, and uses AI-driven generation to fill gaps in acceptance criteria, surface security risks, and produce executive handoff briefs — all without leaving the Atlassian product.

---

## Screenshots / Demo

> _Deploy to your Atlassian cloud site and open any Jira issue to see the live panel. A rich demo view renders automatically even without a real issue context._

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Atlassian Cloud (Jira / Confluence)           │
│                                                                 │
│   ┌─────────────────────┐    ┌────────────────────────────────┐  │
│   │  jira:issuePanel    │    │  confluence:contentBylineItem  │  │
│   │  (Custom UI)        │    │  (Custom UI)                   │  │
│   │  static/main/       │    │  static/main/                  │  │
│   │  index.html         │    │  index.html                    │  │
│   │  app.js             │    │  app.js                        │  │
│   │  styles.css         │    │  styles.css                    │  │
│   └────────┬────────────┘    └───────────────┬────────────────┘  │
│            │ @forge/bridge invoke()           │                   │
│            └───────────────┬─────────────────┘                   │
│                            ▼                                     │
│   ┌────────────────────────────────────────────────────────────┐  │
│   │              Forge Function: src/index.js                  │  │
│   │  @forge/resolver handlers:                                 │  │
│   │  • getContextData   — reads Jira/Confluence via asUser()   │  │
│   │  • runContextAudit  — scores + generates AI content        │  │
│   │  • saveAuditSnapshot — persists to Forge Storage           │  │
│   │  • getAuditHistory  — retrieves stored audit index         │  │
│   │  Rovo action handlers:                                     │  │
│   │  • fetchIssueContext  — Rovo agent data fetch              │  │
│   │  • logReadinessAudit  — Rovo agent audit logging           │  │
│   └──────────────┬────────────────────────────────────────────┘  │
│                  │                                               │
│    ┌─────────────┴──────────┐   ┌────────────────────────────┐  │
│    │  Jira REST API v3      │   │  Forge Storage (KV store)  │  │
│    │  Confluence REST API   │   │  audit snapshots + index   │  │
│    └────────────────────────┘   └────────────────────────────┘  │
│                                                                 │
│   ┌────────────────────────────────────────────────────────────┐  │
│   │              rovo:agent — ContextGuard Release Copilot     │  │
│   │  Conversation starters + AI prompt + actions:              │  │
│   │  fetch-issue-context  →  fetchIssueContext resolver        │  │
│   │  log-readiness-audit  →  logReadinessAudit resolver        │  │
│   └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Forge Modules

| Module | Key | Purpose |
|---|---|---|
| `jira:issuePanel` | `contextguard-jira-panel` | Live issue context + readiness score inline in every Jira issue |
| `confluence:contentBylineItem` | `contextguard-confluence-byline` | Spec drift detector surfaced in Confluence page bylines |
| `rovo:agent` | `contextguard-rovo-agent` | Conversational AI agent for release readiness Q&A |
| `action` | `fetch-issue-context` | Rovo agent action — fetch structured issue/page context |
| `action` | `log-readiness-audit` | Rovo agent action — persist audit findings to Forge Storage |
| `storage:app` | _(implicit)_ | Stateful audit snapshot persistence across sessions |

---

## Features

### Context Readiness Score (0–100%)

Automatically computed across four pillars:

| Pillar | Weight | What's checked |
|---|---|---|
| **Acceptance Criteria Clarity** | 25 pts | Gherkin/AC presence, specificity, testability |
| **Security & Compliance** | 25 pts | OWASP keywords, PII/GDPR flags, security labels |
| **Dependency Completeness** | 25 pts | Linked issues, open blockers, cross-team deps |
| **Spec Alignment** | 25 pts | Confluence spec linked, draft/placeholder detection |

### AI Context Actions

- **Generate Missing Acceptance Criteria** — Produces Gherkin (Given/When/Then) ACs tailored to the issue domain (auth, mobile, API, etc.)
- **Run Pre-Release Security & Risk Audit** — OWASP Top-10 touch-point analysis, PII/GDPR data-flow review, go/no-go recommendation
- **Synthesize Executive Handoff Brief** — Plain-English summary for stakeholders: what ships, what risks remain, action items
- **Full Release Audit** — All three above combined in one structured report
- **Save Audit Snapshot** — Persists score + findings to Forge Storage; viewable in the History tab

### Rovo Agent

The **ContextGuard Release Copilot** Rovo agent can:
- Answer natural-language questions about any Jira issue's release readiness
- Fetch and score issue context on demand via the `fetch-issue-context` action
- Log audit findings to Forge Storage via `log-readiness-audit` for traceability
- Use conversation starters to guide users through common audit workflows

### Forge Storage (Stateful)

All audit snapshots are keyed by entity + timestamp and stored in Forge's built-in KV storage. Judges can verify real storage reads/writes in the History tab — entries persist across sessions and are shared between the Jira panel, Confluence byline, and Rovo agent.

---

## Setup & Deployment

### Prerequisites

- Node.js ≥ 20
- Atlassian Forge CLI: `npm install -g @forge/cli`
- An Atlassian cloud developer site: [go.atlassian.com/cloud-dev](https://go.atlassian.com/cloud-dev)

### 1. Install dependencies

```bash
npm install
```

### 2. Verify syntax

```bash
npm run check
# → All syntax checks passed
```

### 3. Register the app

```bash
forge register
```

This replaces the placeholder `app.id` in `manifest.yml` with a real ARI.

### 4. Deploy

```bash
forge deploy
```

### 5. Install on your site

```bash
forge install
```

Select your Atlassian cloud site and choose both **Jira** and **Confluence** when prompted.

### 6. Test

1. Open any Jira issue — the **ContextGuard AI** panel appears in the right sidebar.
2. The Context Readiness Score computes automatically.
3. Click **Generate Missing ACs**, **Security & Risk Audit**, or **Executive Handoff Brief**.
4. Click **Save Audit Snapshot** — verify persistence in the **History** tab.
5. Open any Confluence page — the byline item runs the same audit for spec drift detection.
6. In Rovo, chat with **ContextGuard Release Copilot** using the provided conversation starters.

### Local tunnel (optional)

```bash
forge tunnel
```

Changes to `src/index.js` hot-reload via the tunnel without a full redeploy.

---

## Testing Guide for Codegeist 2026 Judges

| What to verify | How |
|---|---|
| **Jira panel renders** | Open any issue; panel appears in right sidebar |
| **Demo mode** | Panel renders richly even without a real issue context |
| **Score computation** | Four pillar bars + risk flags appear immediately |
| **AC generation** | Click "Generate Missing ACs" — Gherkin output appears |
| **Security audit** | Click "Security & Risk Audit" — OWASP report with go/no-go |
| **Executive brief** | Click "Executive Handoff Brief" — stakeholder-ready summary |
| **Forge Storage write** | Click "Save Audit Snapshot" — success toast shown |
| **Forge Storage read** | Switch to History tab — saved entry appears with score + timestamp |
| **Confluence byline** | Open any Confluence page — byline item shows ContextGuard |
| **Rovo agent** | Open Rovo, find ContextGuard Release Copilot, use conversation starters |
| **Rovo action — fetch** | Ask "Audit issue PROJ-123" — agent calls `fetch-issue-context` |
| **Rovo action — log** | Agent calls `log-readiness-audit`; entry visible in panel History tab |

---

## Project Structure

```
codegeist-contextguard/
├── manifest.yml              # Forge app manifest (modules, permissions, resources)
├── package.json              # Node dependencies (@forge/api, @forge/resolver)
├── src/
│   └── index.js              # Forge resolver + Rovo agent action handlers
├── static/
│   └── main/                 # Custom UI (zero-bundler, vanilla JS)
│       ├── index.html        # HTML shell + @forge/bridge bootstrap
│       ├── styles.css        # Atlassian Design System–inspired stylesheet
│       └── app.js            # UI logic, rendering, bridge calls
├── README.md
└── LICENSE
```

---

## Security & Privacy

- All Jira/Confluence reads use `asUser()` — the app only accesses data the installing user has permission to see.
- No data is sent to external services. All AI content is generated locally in the Forge function using deterministic rule-based logic.
- Forge Storage entries are scoped to the app installation — no cross-tenant data leakage.
- Required OAuth scopes are minimal: `read:jira-work`, `write:jira-work`, `read:confluence-content.summary`, `read:confluence-content.all`, `storage:app`.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

## Codegeist 2026

Built for the **Apps for Software Teams** track and the **Best Rovo Agent** bonus prize.

> _ContextGuard AI closes the loop between engineering intent and release confidence — right inside the tools teams already use._
