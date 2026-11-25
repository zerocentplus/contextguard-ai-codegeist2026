'use strict';

/**
 * ContextGuard AI — Custom UI front-end
 * Uses @forge/bridge for resolver calls and view.getContext()
 */

/* global ForgeUI */

// ─── Bridge bootstrap ──────────────────────────────────────────────────────────
// @forge/bridge is loaded via the CDN script tag in index.html
// and exposed as window.ForgeUI (alias set below after load)
let bridge = null;
let view   = null;

function initBridge() {
  if (window.AP && window.AP.dialog) {
    // Running inside Connect — not expected but handle gracefully
    console.warn('ContextGuard: AP bridge detected, expected Forge bridge');
  }
  // @forge/bridge attaches to window as ForgeUI
  if (window.ForgeUI) {
    bridge = window.ForgeUI.invoke;
    view   = window.ForgeUI.view;
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  loading: true,
  context: null,
  score: null,
  flags: [],
  pillars: {},
  output: { visible: false, title: '', content: '' },
  history: [],
  activeTab: 'audit',
  saving: false,
  auditing: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function $(selector, root) { return (root || document).querySelector(selector); }
function $$(selector, root) { return Array.from((root || document).querySelectorAll(selector)); }

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Minimal markdown-ish renderer: headings, bold, inline code, lists */
function renderMarkdown(text) {
  if (!text) return '';
  return escapeHtml(text)
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '• $1')
    .replace(/^(\d+)\. (.+)$/gm, '$1. $2')
    .replace(/\n{2,}/g, '\n\n');
}

function formatTime(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (_) {
    return isoString;
  }
}

function relativeTime(isoString) {
  if (!isoString) return '';
  try {
    const delta = Date.now() - new Date(isoString).getTime();
    const mins  = Math.floor(delta / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch (_) {
    return '';
  }
}

function getStatusClass(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('progress') || s.includes('review')) return 'in-progress';
  if (s.includes('done') || s.includes('closed') || s.includes('resolved')) return 'done';
  if (s.includes('block')) return 'blocked';
  return 'todo';
}

function getPriorityClass(priority) {
  const p = (priority || '').toLowerCase();
  if (p === 'critical' || p === 'blocker') return 'critical';
  if (p === 'high') return 'high';
  if (p === 'medium' || p === 'major') return 'medium';
  return 'low';
}

function getScoreColor(score) {
  if (score >= 80) return '#36b37e';
  if (score >= 55) return '#ff8b00';
  return '#de350b';
}

function getBarColor(score, max) {
  const pct = (score / max) * 100;
  if (pct >= 80) return '#36b37e';
  if (pct >= 50) return '#ff8b00';
  return '#de350b';
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(message, type) {
  const container = $('#toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `cg-toast ${type || 'info'}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 3200);
}

// ─── Bridge invoke wrapper ────────────────────────────────────────────────────

async function invoke(funcName, payload) {
  if (!bridge) {
    console.error('Bridge not initialised — cannot invoke', funcName);
    throw new Error('Bridge not available');
  }
  return bridge(funcName, payload || {});
}

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderContextCard(ctx) {
  if (!ctx) return '<div class="cg-empty">No context available.</div>';

  const isPage = !!ctx.pageId;

  if (isPage) {
    return `
      ${ctx.isDemo ? '<div class="cg-demo-notice">⚡ Demo data — open this panel on a live Confluence page for real context.</div>' : ''}
      <div class="cg-context-grid">
        <div class="cg-context-field">
          <span class="cg-field-label">Page ID</span>
          <span class="cg-field-value">${escapeHtml(ctx.pageId)}</span>
        </div>
        <div class="cg-context-field">
          <span class="cg-field-label">Space</span>
          <span class="cg-field-value">${escapeHtml(ctx.spaceKey) || '—'}</span>
        </div>
        <div class="cg-context-field full-width">
          <span class="cg-field-label">Title</span>
          <span class="cg-field-value">${escapeHtml(ctx.title)}</span>
        </div>
        <div class="cg-context-field">
          <span class="cg-field-label">Last Modified</span>
          <span class="cg-field-value">${formatTime(ctx.lastModified)}</span>
        </div>
        <div class="cg-context-field">
          <span class="cg-field-label">Author</span>
          <span class="cg-field-value">${escapeHtml(ctx.author) || '—'}</span>
        </div>
        ${ctx.labels && ctx.labels.length > 0 ? `
        <div class="cg-context-field full-width">
          <span class="cg-field-label">Labels</span>
          <div class="cg-chips-wrap">${ctx.labels.map((l) => `<span class="cg-chip">${escapeHtml(l)}</span>`).join('')}</div>
        </div>` : ''}
        <div class="cg-context-field full-width">
          <span class="cg-field-label">Excerpt</span>
          <span class="cg-field-value muted">${escapeHtml(ctx.excerpt)}</span>
        </div>
      </div>`;
  }

  // Jira issue
  const linkedHtml = ctx.linkedIssues && ctx.linkedIssues.length > 0
    ? `<div class="cg-linked-list">${ctx.linkedIssues.map((l) =>
        `<div class="cg-linked-item">
          <span class="cg-linked-key">${escapeHtml(l.key)}</span>
          <span class="cg-linked-type">${escapeHtml(l.type)}</span>
          <span>${escapeHtml(l.summary)}</span>
        </div>`).join('')}</div>`
    : '<span class="cg-field-value muted">None</span>';

  return `
    ${ctx.isDemo ? '<div class="cg-demo-notice">⚡ Demo data — open this panel on a live Jira issue for real context.</div>' : ''}
    <div class="cg-context-grid">
      <div class="cg-context-field">
        <span class="cg-field-label">Issue Key</span>
        <span class="cg-field-value" style="color:var(--color-brand);font-weight:700;">${escapeHtml(ctx.key)}</span>
      </div>
      <div class="cg-context-field">
        <span class="cg-field-label">Status</span>
        <span class="cg-status ${getStatusClass(ctx.status)}">${escapeHtml(ctx.status)}</span>
      </div>
      <div class="cg-context-field full-width">
        <span class="cg-field-label">Summary</span>
        <span class="cg-field-value">${escapeHtml(ctx.summary)}</span>
      </div>
      <div class="cg-context-field">
        <span class="cg-field-label">Priority</span>
        <span class="cg-priority ${getPriorityClass(ctx.priority)}">${escapeHtml(ctx.priority) || '—'}</span>
      </div>
      <div class="cg-context-field">
        <span class="cg-field-label">Assignee</span>
        <span class="cg-field-value">${escapeHtml(ctx.assignee) || 'Unassigned'}</span>
      </div>
      <div class="cg-context-field">
        <span class="cg-field-label">Reporter</span>
        <span class="cg-field-value">${escapeHtml(ctx.reporter) || '—'}</span>
      </div>
      <div class="cg-context-field">
        <span class="cg-field-label">Fix Version</span>
        <span class="cg-field-value">${ctx.fixVersions && ctx.fixVersions.length ? escapeHtml(ctx.fixVersions.join(', ')) : '—'}</span>
      </div>
      ${ctx.labels && ctx.labels.length > 0 ? `
      <div class="cg-context-field full-width">
        <span class="cg-field-label">Labels</span>
        <div class="cg-chips-wrap">${ctx.labels.map((l) => `<span class="cg-chip">${escapeHtml(l)}</span>`).join('')}</div>
      </div>` : ''}
      <div class="cg-context-field full-width">
        <span class="cg-field-label">Linked Issues</span>
        ${linkedHtml}
      </div>
      <div class="cg-context-field full-width">
        <span class="cg-field-label">Description</span>
        <span class="cg-field-value muted">${escapeHtml((ctx.description || '').replace(/"type":"[^"]*",/g, '').slice(0, 300)) || 'No description.'}</span>
      </div>
    </div>`;
}

function renderScoreSection(scoreResult) {
  if (!scoreResult) {
    return '<div class="cg-empty">Run an audit to see the score.</div>';
  }

  const { total, pillars, flags } = scoreResult;
  const circumference = 2 * Math.PI * 42; // radius 42
  const offset = circumference - (total / 100) * circumference;
  const color = getScoreColor(total);

  const pillarsHtml = Object.entries(pillars).map(([, p]) => {
    const pct = Math.round((p.score / p.max) * 100);
    const barColor = getBarColor(p.score, p.max);
    return `
      <div class="cg-pillar-row">
        <div class="cg-pillar-label-row">
          <span class="cg-pillar-name">${escapeHtml(p.label)}</span>
          <span class="cg-pillar-score">${p.score}/${p.max}</span>
        </div>
        <div class="cg-progress-bar-bg">
          <div class="cg-progress-bar-fill" style="width:${pct}%;background:${barColor};"></div>
        </div>
      </div>`;
  }).join('');

  const flagsHtml = flags && flags.length > 0
    ? `<div class="cg-flags-list">${flags.map((f) =>
        `<div class="cg-flag ${escapeHtml(f.severity)}">
          <span class="cg-flag-severity">${escapeHtml(f.severity)}</span>
          <span class="cg-flag-pillar">[${escapeHtml(f.pillar)}]</span>
          <span class="cg-flag-message">${escapeHtml(f.message)}</span>
        </div>`).join('')}</div>`
    : '<div class="cg-empty">✅ No flags raised.</div>';

  return `
    <div class="cg-score-container">
      <div class="cg-score-ring-wrap">
        <svg class="cg-score-ring" viewBox="0 0 100 100" width="100" height="100">
          <circle class="cg-score-ring-bg" cx="50" cy="50" r="42"></circle>
          <circle class="cg-score-ring-fill"
            cx="50" cy="50" r="42"
            stroke="${color}"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${offset}">
          </circle>
        </svg>
        <div class="cg-score-label">
          <span class="cg-score-number" style="color:${color};">${total}</span>
          <span class="cg-score-unit">/ 100</span>
        </div>
      </div>
      <div class="cg-score-pillars">${pillarsHtml}</div>
    </div>
    <div class="cg-divider" style="margin-top:var(--space-md);"></div>
    <div class="cg-card-title" style="margin-bottom:var(--space-sm);padding-top:var(--space-sm);">Risk Flags</div>
    ${flagsHtml}`;
}

function renderHistory(history) {
  if (!history || history.length === 0) {
    return '<div class="cg-empty">No audit snapshots saved yet. Run an audit and click "Save Snapshot".</div>';
  }

  return `<div class="cg-history-list">
    ${history.map((h) => {
      const scoreColor = getScoreColor(h.score || 0);
      return `
        <div class="cg-history-item" data-key="${escapeHtml(h.key || '')}">
          <span class="cg-history-score" style="color:${scoreColor};">${h.score || 0}</span>
          <span class="cg-history-entity">${escapeHtml(h.entityKey || '—')}</span>
          ${h.source === 'rovo-agent' ? '<span class="cg-history-source">Rovo</span>' : ''}
          <span class="cg-history-time">${relativeTime(h.timestamp)}</span>
        </div>`;
    }).join('')}
  </div>`;
}

// ─── Main render ──────────────────────────────────────────────────────────────

function render() {
  const app = $('#app');
  if (!app) return;

  if (state.loading) {
    app.innerHTML = `
      <div class="cg-header">
        <div class="cg-header-logo">CG</div>
        <span class="cg-header-title"><span>Context</span>Guard AI</span>
        <span class="cg-header-badge">Forge</span>
      </div>
      <div class="cg-loading">
        <div class="cg-spinner"></div>
        <span>Loading context…</span>
      </div>
      <div class="cg-toast-container" id="toast-container"></div>`;
    return;
  }

  const ctx = state.context;
  const hasScore = !!state.score;
  const auditBtnLabel = state.auditing ? '⏳ Analysing…' : '🔍 Analyse & Score';

  app.innerHTML = `
    <div class="cg-header">
      <div class="cg-header-logo">CG</div>
      <span class="cg-header-title"><span>Context</span>Guard AI</span>
      <span class="cg-header-badge">Forge</span>
    </div>

    <div class="cg-tabs">
      <button class="cg-tab ${state.activeTab === 'audit' ? 'active' : ''}" data-tab="audit">Audit</button>
      <button class="cg-tab ${state.activeTab === 'context' ? 'active' : ''}" data-tab="context">Context</button>
      <button class="cg-tab ${state.activeTab === 'history' ? 'active' : ''}" data-tab="history">History</button>
    </div>

    <!-- Audit tab -->
    <div class="cg-tab-panel ${state.activeTab === 'audit' ? 'active' : ''}" id="tab-audit">
      <!-- Score card -->
      <div class="cg-card" style="margin-bottom:var(--space-md);">
        <div class="cg-card-header">
          <span class="cg-card-title">Context Readiness Score</span>
          ${hasScore ? `<span style="font-size:var(--font-size-xs);color:var(--color-text-secondary);">Last run: ${relativeTime(state.lastAuditTime)}</span>` : ''}
        </div>
        <div class="cg-card-body" id="score-section">
          ${hasScore ? renderScoreSection(state.score) : '<div class="cg-empty">Click "Analyse &amp; Score" below to compute the Context Readiness Score.</div>'}
        </div>
      </div>

      <!-- AI Actions -->
      <div class="cg-card">
        <div class="cg-card-header">
          <span class="cg-card-title">AI Context Actions</span>
        </div>
        <div class="cg-card-body">
          <div class="cg-actions-grid">
            <button class="cg-btn cg-btn-primary cg-btn-full" id="btn-analyse" ${state.auditing ? 'disabled' : ''}>
              ${auditBtnLabel}
            </button>
            <button class="cg-btn cg-btn-secondary" id="btn-gen-ac" ${state.auditing ? 'disabled' : ''}>
              ✏️ Generate Missing ACs
            </button>
            <button class="cg-btn cg-btn-secondary" id="btn-security" ${state.auditing ? 'disabled' : ''}>
              🔒 Security &amp; Risk Audit
            </button>
            <button class="cg-btn cg-btn-secondary" id="btn-brief" ${state.auditing ? 'disabled' : ''}>
              📋 Executive Handoff Brief
            </button>
            <button class="cg-btn cg-btn-success ${!hasScore ? 'cg-btn-full' : ''}" id="btn-save" ${state.saving || !hasScore ? 'disabled' : ''}>
              ${state.saving ? '⏳ Saving…' : '💾 Save Audit Snapshot'}
            </button>
            ${hasScore ? `<button class="cg-btn cg-btn-danger" id="btn-full-audit" ${state.auditing ? 'disabled' : ''}>
              🚀 Full Release Audit
            </button>` : ''}
          </div>

          <!-- Output panel -->
          <div class="cg-output ${state.output.visible ? 'visible' : ''}" id="output-panel" style="margin-top:var(--space-md);">
            <div class="cg-output-header">
              <span class="cg-output-title" id="output-title">${escapeHtml(state.output.title)}</span>
              <button class="cg-btn cg-btn-secondary" id="btn-copy" style="padding:3px 10px;font-size:var(--font-size-xs);">Copy</button>
            </div>
            <div class="cg-output-content" id="output-content">${renderMarkdown(state.output.content)}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Context tab -->
    <div class="cg-tab-panel ${state.activeTab === 'context' ? 'active' : ''}" id="tab-context">
      <div class="cg-card">
        <div class="cg-card-header">
          <span class="cg-card-title">${ctx && ctx.pageId ? 'Confluence Page' : 'Jira Issue'} Context</span>
          <button class="cg-btn cg-btn-secondary" id="btn-refresh" style="padding:3px 10px;font-size:var(--font-size-xs);">↻ Refresh</button>
        </div>
        <div class="cg-card-body">${renderContextCard(ctx)}</div>
      </div>
    </div>

    <!-- History tab -->
    <div class="cg-tab-panel ${state.activeTab === 'history' ? 'active' : ''}" id="tab-history">
      <div class="cg-card">
        <div class="cg-card-header">
          <span class="cg-card-title">Audit Snapshot History</span>
          <button class="cg-btn cg-btn-secondary" id="btn-load-history" style="padding:3px 10px;font-size:var(--font-size-xs);">↻ Refresh</button>
        </div>
        <div class="cg-card-body" id="history-section">${renderHistory(state.history)}</div>
      </div>
    </div>

    <div class="cg-toast-container" id="toast-container"></div>`;

  attachEventListeners();
}

// ─── Event listeners ──────────────────────────────────────────────────────────

function attachEventListeners() {
  // Tabs
  $$('.cg-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      if (state.activeTab === 'history') loadHistory();
      render();
    });
  });

  // Refresh context
  const btnRefresh = $('#btn-refresh');
  if (btnRefresh) btnRefresh.addEventListener('click', loadContext);

  // Analyse & Score
  const btnAnalyse = $('#btn-analyse');
  if (btnAnalyse) {
    btnAnalyse.addEventListener('click', async () => {
      await runAudit(null); // null = score-only, no content generation
    });
  }

  // Generate ACs
  const btnGenAc = $('#btn-gen-ac');
  if (btnGenAc) btnGenAc.addEventListener('click', () => runAudit('acceptanceCriteria'));

  // Security audit
  const btnSecurity = $('#btn-security');
  if (btnSecurity) btnSecurity.addEventListener('click', () => runAudit('securityAudit'));

  // Executive brief
  const btnBrief = $('#btn-brief');
  if (btnBrief) btnBrief.addEventListener('click', () => runAudit('executiveBrief'));

  // Full release audit
  const btnFull = $('#btn-full-audit');
  if (btnFull) btnFull.addEventListener('click', () => runAudit('full'));

  // Save snapshot
  const btnSave = $('#btn-save');
  if (btnSave) btnSave.addEventListener('click', saveSnapshot);

  // Copy output
  const btnCopy = $('#btn-copy');
  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      if (state.output.content) {
        navigator.clipboard.writeText(state.output.content)
          .then(() => showToast('Copied to clipboard!', 'success'))
          .catch(() => showToast('Copy failed — select text manually.', 'error'));
      }
    });
  }

  // Load history refresh
  const btnLoadHistory = $('#btn-load-history');
  if (btnLoadHistory) btnLoadHistory.addEventListener('click', loadHistory);
}

// ─── Data operations ──────────────────────────────────────────────────────────

async function loadContext() {
  state.loading = true;
  render();
  try {
    const result = await invoke('getContextData', {});
    if (result && result.success) {
      state.context = result.data;
      // Auto-score when context is loaded
      await computeScore(result.data);
    } else {
      showToast('Could not load context — showing demo data.', 'info');
    }
  } catch (err) {
    console.error('loadContext error:', err);
    showToast('Bridge error loading context.', 'error');
  }
  state.loading = false;
  render();
}

async function computeScore(contextData) {
  try {
    const result = await invoke('runContextAudit', {
      context: contextData,
      auditType: null,
    });
    if (result && result.success) {
      state.score = result.score;
      state.lastAuditTime = result.timestamp;
    }
  } catch (err) {
    console.error('computeScore error:', err);
  }
}

async function runAudit(auditType) {
  if (!state.context) {
    showToast('No context loaded yet.', 'error');
    return;
  }
  state.auditing = true;
  render();

  const titles = {
    acceptanceCriteria: '✏️ Generated Acceptance Criteria',
    securityAudit:      '🔒 Security & Risk Audit Report',
    executiveBrief:     '📋 Executive Handoff Brief',
    full:               '🚀 Full Release Audit Report',
  };

  try {
    const result = await invoke('runContextAudit', {
      context: state.context,
      auditType: auditType || null,
    });
    if (result && result.success) {
      state.score = result.score;
      state.lastAuditTime = result.timestamp;
      if (auditType) {
        state.output = {
          visible: true,
          title: titles[auditType] || 'Audit Result',
          content: result.generatedContent || '',
        };
      }
      showToast('Audit complete!', 'success');
    } else {
      showToast(result.error || 'Audit failed.', 'error');
    }
  } catch (err) {
    console.error('runAudit error:', err);
    showToast('Audit error: ' + err.message, 'error');
  }

  state.auditing = false;
  render();
}

async function saveSnapshot() {
  if (!state.context || !state.score) {
    showToast('Run an audit first before saving.', 'error');
    return;
  }
  state.saving = true;
  render();

  const entityKey = state.context.key || state.context.pageId || 'unknown';
  try {
    const result = await invoke('saveAuditSnapshot', {
      entityKey,
      snapshot: {
        score: state.score.total,
        flags: state.score.flags,
        auditType: state.output.visible ? state.output.title : 'score-only',
        summary: state.context.summary || state.context.title || '',
        generatedContent: state.output.content || '',
      },
    });
    if (result && result.success) {
      showToast(`Snapshot saved for ${entityKey} (score: ${state.score.total}/100)`, 'success');
      await loadHistory();
    } else {
      showToast(result.error || 'Save failed.', 'error');
    }
  } catch (err) {
    console.error('saveSnapshot error:', err);
    showToast('Save error: ' + err.message, 'error');
  }

  state.saving = false;
  render();
}

async function loadHistory() {
  try {
    const entityKey = state.context
      ? (state.context.key || state.context.pageId)
      : null;
    const result = await invoke('getAuditHistory', { entityKey, limit: 10 });
    if (result && result.success) {
      state.history = result.history || [];
      const historySection = $('#history-section');
      if (historySection) {
        historySection.innerHTML = renderHistory(state.history);
      }
    }
  } catch (err) {
    console.error('loadHistory error:', err);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  // Render loading state immediately
  render();

  // Wait for @forge/bridge CDN script to initialise
  let attempts = 0;
  while (!window.ForgeUI && attempts < 20) {
    await new Promise((r) => setTimeout(r, 100));
    attempts++;
  }
  initBridge();

  if (!bridge) {
    // Bridge not available (e.g. opened directly in browser for dev)
    // Fall back to simulated demo mode
    console.warn('ContextGuard: @forge/bridge not available — running in demo mode');
    state.loading = false;

    // Simulate demo context inline (mirrors DEMO_ISSUE_CONTEXT from backend)
    state.context = {
      key: 'DEMO-42',
      summary: 'Implement OAuth 2.0 PKCE flow for mobile authentication',
      status: 'In Progress',
      priority: 'High',
      assignee: 'Alex Rivera',
      reporter: 'Jordan Kim',
      description: 'Replace legacy implicit grant with PKCE for mobile. Affects iOS, Android, React Native. No ACs yet. Blocked by INFRA-88.',
      labels: ['security', 'mobile', 'auth', 'breaking-change'],
      components: ['Mobile', 'Auth Service'],
      fixVersions: ['v4.2.0'],
      linkedIssues: [
        { key: 'INFRA-88', type: 'is blocked by', summary: 'TLS cert rotation — prod' },
        { key: 'MOBILE-33', type: 'relates to', summary: 'iOS Keychain token storage' },
      ],
      confluenceLinks: ['oauth-pkce-design'],
      isDemo: true,
    };

    // Simulate a computed score for demo mode
    state.score = {
      total: 60,
      pillars: {
        acceptanceCriteria: { score: 5,  max: 25, label: 'Acceptance Criteria' },
        securityCompliance: { score: 18, max: 25, label: 'Security & Compliance' },
        dependencyCompleteness: { score: 10, max: 25, label: 'Dependency Completeness' },
        specAlignment: { score: 27, max: 25, label: 'Spec Alignment' },
      },
      flags: [
        { severity: 'HIGH',   pillar: 'AC',           message: 'No acceptance criteria detected. AI generation recommended.' },
        { severity: 'HIGH',   pillar: 'Dependencies', message: '1 open blocker(s): INFRA-88.' },
        { severity: 'LOW',    pillar: 'Security',     message: 'Security feature detected — OWASP risk enumeration not found in description.' },
      ],
    };
    state.lastAuditTime = new Date().toISOString();
    render();
    return;
  }

  // Real Forge environment
  await loadContext();
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
