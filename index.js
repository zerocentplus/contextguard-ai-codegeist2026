'use strict';

/**
 * ContextGuard AI — Engineering Context & Release Readiness Copilot
 * Forge backend resolver + Rovo agent action handlers
 *
 * Modules handled:
 *  - jira:issuePanel        → getContextData
 *  - confluence:contentBylineItem → getContextData (page variant)
 *  - rovo:agent actions     → fetchIssueContext, logReadinessAudit
 *  - UI bridge calls        → runContextAudit, saveAuditSnapshot, getAuditHistory
 */

const Resolver = require('@forge/resolver');
const { route, storage, asUser } = require('@forge/api');

const resolver = new Resolver();

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_AUDIT_PREFIX = 'audit_';
const STORAGE_HISTORY_INDEX = 'audit_history_index';
const MAX_HISTORY_ENTRIES = 50;

// ─── Fallback / demo data (renders richly when outside a real issue) ──────────

const DEMO_ISSUE_CONTEXT = {
  key: 'DEMO-42',
  summary: 'Implement OAuth 2.0 PKCE flow for mobile authentication',
  status: 'In Progress',
  priority: 'High',
  assignee: 'Alex Rivera',
  reporter: 'Jordan Kim',
  description:
    'We need to replace the legacy implicit grant with PKCE for the mobile ' +
    'app. This affects iOS, Android, and the React Native bridge layer. ' +
    'No explicit acceptance criteria have been written yet. ' +
    'Blocked by INFRA-88 (cert rotation). Linked spec: confluence://specs/oauth-pkce-design.',
  labels: ['security', 'mobile', 'auth', 'breaking-change'],
  components: ['Mobile', 'Auth Service'],
  fixVersions: ['v4.2.0'],
  linkedIssues: [
    { key: 'INFRA-88', type: 'is blocked by', summary: 'TLS cert rotation — prod' },
    { key: 'MOBILE-33', type: 'relates to', summary: 'iOS Keychain token storage' },
  ],
  confluenceLinks: ['oauth-pkce-design'],
  created: '2025-11-01T09:00:00.000Z',
  updated: '2025-12-10T14:22:00.000Z',
  isDemo: true,
};

const DEMO_PAGE_CONTEXT = {
  pageId: 'demo-99',
  title: 'OAuth PKCE Flow — Technical Design Spec',
  spaceKey: 'ARCH',
  author: 'Jordan Kim',
  lastModified: '2025-11-28T11:00:00.000Z',
  excerpt:
    'This document specifies the PKCE extension for OAuth 2.0 on mobile clients. ' +
    'Covers code_verifier generation, CORS policy, token endpoint hardening, and ' +
    'revocation strategy. Section 4 (Rate limiting) is still a draft placeholder.',
  labels: ['security', 'mobile', 'auth'],
  isDemo: true,
};

// ─── Scoring engine ────────────────────────────────────────────────────────────

/**
 * Compute a Context Readiness Score from 0–100 across four pillars.
 * Returns { total, pillars, flags }
 */
function computeReadinessScore(context) {
  const pillars = {
    acceptanceCriteria: { score: 0, max: 25, label: 'Acceptance Criteria' },
    securityCompliance: { score: 0, max: 25, label: 'Security & Compliance' },
    dependencyCompleteness: { score: 0, max: 25, label: 'Dependency Completeness' },
    specAlignment: { score: 0, max: 25, label: 'Spec Alignment' },
  };
  const flags = [];

  // ── Pillar 1: Acceptance Criteria (25 pts) ──────────────────────────────
  const desc = (context.description || context.excerpt || '').toLowerCase();
  const hasGherkin = /\b(given|when|then|and|but)\b/.test(desc);
  const hasAcSection =
    /acceptance criteria|definition of done|ac:|given\/when\/then|\bac\b/.test(desc);
  const descLength = desc.length;

  if (hasGherkin) {
    pillars.acceptanceCriteria.score = 25;
  } else if (hasAcSection) {
    pillars.acceptanceCriteria.score = 15;
    flags.push({ severity: 'MEDIUM', pillar: 'AC', message: 'ACs present but not in Gherkin format.' });
  } else if (descLength > 200) {
    pillars.acceptanceCriteria.score = 5;
    flags.push({ severity: 'HIGH', pillar: 'AC', message: 'No acceptance criteria detected. AI generation recommended.' });
  } else {
    pillars.acceptanceCriteria.score = 0;
    flags.push({ severity: 'CRITICAL', pillar: 'AC', message: 'Description is too short to infer any acceptance criteria.' });
  }

  // ── Pillar 2: Security & Compliance (25 pts) ────────────────────────────
  const securityKeywords = ['auth', 'oauth', 'jwt', 'token', 'pkce', 'tls', 'ssl', 'encrypt', 'pii', 'gdpr', 'rbac', 'acl'];
  const riskKeywords = ['sql inject', 'xss', 'csrf', 'idor', 'secret', 'password', 'credential'];
  const hasSecurityContext = securityKeywords.some((k) => desc.includes(k));
  const hasRiskMention = riskKeywords.some((k) => desc.includes(k));
  const hasSecurityLabel = (context.labels || []).some((l) =>
    ['security', 'compliance', 'gdpr', 'auth', 'pii'].includes(l.toLowerCase())
  );

  if (hasSecurityContext && hasSecurityLabel) {
    pillars.securityCompliance.score = 20;
    if (!hasRiskMention) {
      pillars.securityCompliance.score = 18;
      flags.push({ severity: 'LOW', pillar: 'Security', message: 'Security feature detected — OWASP risk enumeration not found in description.' });
    }
  } else if (hasSecurityContext) {
    pillars.securityCompliance.score = 12;
    flags.push({ severity: 'MEDIUM', pillar: 'Security', message: 'Security-related work detected without explicit security labels or risk documentation.' });
  } else {
    pillars.securityCompliance.score = 20; // non-security work scores neutrally
  }

  // ── Pillar 3: Dependency Completeness (25 pts) ──────────────────────────
  const linkedIssues = context.linkedIssues || [];
  const blockers = linkedIssues.filter((l) =>
    (l.type || '').toLowerCase().includes('blocked')
  );
  const hasBlockers = blockers.length > 0;
  const hasLinkedWork = linkedIssues.length > 0;

  if (hasBlockers) {
    pillars.dependencyCompleteness.score = 10;
    flags.push({
      severity: 'HIGH',
      pillar: 'Dependencies',
      message: `${blockers.length} open blocker(s): ${blockers.map((b) => b.key).join(', ')}.`,
    });
  } else if (hasLinkedWork) {
    pillars.dependencyCompleteness.score = 22;
  } else {
    pillars.dependencyCompleteness.score = 15;
    flags.push({ severity: 'LOW', pillar: 'Dependencies', message: 'No linked issues found — dependencies may be undocumented.' });
  }

  // ── Pillar 4: Spec Alignment (25 pts) ───────────────────────────────────
  const confluenceLinks = context.confluenceLinks || [];
  const hasDraftMention = desc.includes('draft') || desc.includes('placeholder') || desc.includes('tbd') || desc.includes('todo');
  const hasSpecLink = confluenceLinks.length > 0;

  if (hasSpecLink && !hasDraftMention) {
    pillars.specAlignment.score = 23;
  } else if (hasSpecLink && hasDraftMention) {
    pillars.specAlignment.score = 12;
    flags.push({ severity: 'MEDIUM', pillar: 'Spec', message: 'Linked spec contains draft/placeholder sections — potential spec drift.' });
  } else {
    pillars.specAlignment.score = 5;
    flags.push({ severity: 'HIGH', pillar: 'Spec', message: 'No linked Confluence spec detected. Spec alignment cannot be verified.' });
  }

  const total = Object.values(pillars).reduce((sum, p) => sum + p.score, 0);

  return { total, pillars, flags };
}

// ─── AI content generators ────────────────────────────────────────────────────

function generateAcceptanceCriteria(context) {
  const summary = context.summary || context.title || 'this feature';
  const isAuth = /(auth|oauth|pkce|login|sso|token)/i.test(summary + (context.description || ''));
  const isMobile = /(mobile|ios|android|react native)/i.test(summary + (context.description || ''));
  const isApi = /(api|endpoint|rest|graphql|webhook)/i.test(summary + (context.description || ''));

  const baseACs = [
    `**AC-1 — Happy Path**
  Given a user with valid credentials
  When they initiate the ${summary} flow
  Then the system completes successfully within 2 seconds
  And a confirmation event is emitted to the audit log`,

    `**AC-2 — Error Handling**
  Given the upstream service is unavailable
  When the user attempts ${summary}
  Then a user-friendly error message is displayed
  And the system retries up to 3 times with exponential backoff`,

    `**AC-3 — Idempotency**
  Given a duplicate request for ${summary}
  When submitted within a 60-second window
  Then the system returns the original result without side effects`,
  ];

  if (isAuth) {
    baseACs.push(
      `**AC-4 — Authentication Security**
  Given an expired or invalid token
  When accessing a protected resource via ${summary}
  Then the system returns HTTP 401 with a WWW-Authenticate header
  And no sensitive data is included in the error response`,

      `**AC-5 — PKCE Verification** *(if applicable)*
  Given a code_challenge was sent in the authorization request
  When the token endpoint receives the code_verifier
  Then S256 transformation matches the original challenge
  And the token is issued only on a successful match`
    );
  }

  if (isMobile) {
    baseACs.push(
      `**AC-6 — Mobile Deep Link**
  Given the user completes the auth flow in a browser
  When the redirect_uri targets the mobile app scheme
  Then the app intercepts the callback within the custom URI scheme
  And the authorization code is never exposed in device logs`
    );
  }

  if (isApi) {
    baseACs.push(
      `**AC-7 — API Rate Limiting**
  Given a client exceeds 100 requests per minute
  When subsequent requests arrive
  Then the API responds with HTTP 429 and a Retry-After header
  And the rate limit window resets after 60 seconds`
    );
  }

  baseACs.push(
    `**AC-8 — Observability**
  Given any state change in ${summary}
  When it occurs in production
  Then a structured log entry with correlation ID, user ID (hashed), and timestamp is emitted
  And the event is queryable in the central observability platform within 30 seconds`
  );

  return baseACs.join('\n\n');
}

function generateSecurityAudit(context) {
  const desc = (context.description || context.excerpt || '').toLowerCase();
  const summary = context.summary || context.title || 'this feature';

  const findings = [];

  findings.push(`## Security & Risk Audit — ${summary}\n`);
  findings.push(`### OWASP Top-10 Touch-Point Analysis\n`);

  const owaspChecks = [
    { id: 'A01', name: 'Broken Access Control', risk: desc.includes('admin') || desc.includes('rbac') || desc.includes('permission') ? 'HIGH' : 'LOW', note: 'Verify role-based access rules cover all new endpoints/actions.' },
    { id: 'A02', name: 'Cryptographic Failures', risk: desc.includes('encrypt') || desc.includes('tls') || desc.includes('token') ? 'MEDIUM' : 'LOW', note: 'Confirm TLS 1.2+ enforcement; no secrets in plaintext logs or URLs.' },
    { id: 'A03', name: 'Injection', risk: desc.includes('query') || desc.includes('input') || desc.includes('search') ? 'MEDIUM' : 'LOW', note: 'Parameterised queries and input validation required at all trust boundaries.' },
    { id: 'A04', name: 'Insecure Design', risk: 'LOW', note: 'Threat model reviewed? Document attack surface in spec.' },
    { id: 'A05', name: 'Security Misconfiguration', risk: desc.includes('config') || desc.includes('env') || desc.includes('flag') ? 'MEDIUM' : 'LOW', note: 'No debug flags in production; headers (CSP, HSTS, X-Frame-Options) set.' },
    { id: 'A07', name: 'Identification & Authentication Failures', risk: desc.includes('auth') || desc.includes('oauth') || desc.includes('pkce') ? 'HIGH' : 'LOW', note: 'MFA enforced? Session invalidation on logout/token revocation implemented?' },
    { id: 'A09', name: 'Security Logging & Monitoring Failures', risk: 'MEDIUM', note: 'Audit events (auth success/failure, privilege escalation) must be immutable and queryable.' },
  ];

  owaspChecks.forEach((c) => {
    const icon = c.risk === 'HIGH' ? '🔴' : c.risk === 'MEDIUM' ? '🟡' : '🟢';
    findings.push(`- ${icon} **${c.id}: ${c.name}** — Risk: \`${c.risk}\`  \n  _${c.note}_`);
  });

  findings.push(`\n### Data Flow & Privacy\n`);
  if (desc.includes('pii') || desc.includes('gdpr') || desc.includes('user data') || desc.includes('email')) {
    findings.push(`- 🔴 **PII detected** — Confirm data minimisation, retention policy, and GDPR/CCPA data subject rights implementation.`);
  } else {
    findings.push(`- 🟢 No explicit PII handling detected — verify with data classification registry.`);
  }

  findings.push(`\n### Compliance Checklist\n`);
  findings.push(`- [ ] Security review ticket linked\n- [ ] Pen test scheduled for new auth surface\n- [ ] DPIA completed (if PII is processed)\n- [ ] Secrets rotated post-deployment\n- [ ] Dependency CVE scan clean (Snyk / Dependabot)`);

  findings.push(`\n### Go / No-Go Recommendation\n`);
  const highRisks = owaspChecks.filter((c) => c.risk === 'HIGH').length;
  if (highRisks >= 2) {
    findings.push(`> ⛔ **NO-GO** — ${highRisks} HIGH-risk OWASP items require resolution before release.`);
  } else if (highRisks === 1) {
    findings.push(`> ⚠️ **CONDITIONAL GO** — 1 HIGH-risk item must be mitigated or formally accepted with a tracking ticket.`);
  } else {
    findings.push(`> ✅ **GO** — No critical security blockers detected. Standard post-release monitoring applies.`);
  }

  return findings.join('\n');
}

function generateExecutiveBrief(context, scoreResult) {
  const summary = context.summary || context.title || 'this feature';
  const { total, flags } = scoreResult;
  const criticalFlags = flags.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  const goNoGo = total >= 80 ? '✅ GO' : total >= 55 ? '⚠️ CONDITIONAL GO' : '⛔ NO-GO';

  return `## Executive Handoff Brief

**Feature:** ${summary}
**Readiness Score:** ${total}/100
**Release Recommendation:** ${goNoGo}

### What Ships
${context.description ? context.description.slice(0, 300) + (context.description.length > 300 ? '…' : '') : context.excerpt || 'See linked specification.'}

### Outstanding Risks
${criticalFlags.length > 0
  ? criticalFlags.map((f) => `- 🔴 [${f.pillar}] ${f.message}`).join('\n')
  : '- None critical at this time.'}

### Dependencies
${(context.linkedIssues || []).length > 0
  ? (context.linkedIssues || []).map((l) => `- **${l.key}** (${l.type}): ${l.summary}`).join('\n')
  : '- No linked dependencies recorded.'}

### Action Items Before Release
${total < 80 ? `1. Resolve ${criticalFlags.length} critical flag(s) listed above.\n2. Obtain sign-off from Security and QA leads.\n3. Re-run ContextGuard audit to confirm score ≥ 80.` : '1. Standard release checklist applies.\n2. Post-deployment monitoring window: 48 hours.'}

_Generated by ContextGuard AI on ${new Date().toISOString()}_`;
}

// ─── Forge Resolver handlers ───────────────────────────────────────────────────

/**
 * getContextData
 * Reads the current Jira issue or Confluence page from Forge context.
 * Falls back to demo data when invoked outside a real entity context.
 */
resolver.define('getContextData', async (req) => {
  try {
    const context = req.context || {};
    const extension = context.extension || {};

    // Jira issue panel context
    if (extension.issue && extension.issue.key) {
      const issueKey = extension.issue.key;
      const response = await asUser().requestJira(
        route`/rest/api/3/issue/${issueKey}?fields=summary,status,priority,assignee,reporter,description,labels,components,fixVersions,issuelinks`,
        { headers: { Accept: 'application/json' } }
      );

      if (!response.ok) {
        console.warn(`Jira API returned ${response.status} for ${issueKey} — using demo data`);
        return { success: true, data: DEMO_ISSUE_CONTEXT };
      }

      const issue = await response.json();
      const fields = issue.fields || {};

      const linkedIssues = (fields.issuelinks || []).map((link) => {
        const linked = link.inwardIssue || link.outwardIssue || {};
        return {
          key: linked.key || '',
          type: link.type ? (link.inwardIssue ? link.type.inward : link.type.outward) : '',
          summary: (linked.fields && linked.fields.summary) || '',
        };
      });

      const confluenceLinks = [];
      // Extract confluence remote links if any mention confluence in description
      const descText = fields.description
        ? JSON.stringify(fields.description)
        : '';
      if (descText.toLowerCase().includes('confluence')) {
        confluenceLinks.push('linked-spec');
      }

      return {
        success: true,
        data: {
          key: issue.key,
          summary: fields.summary || '',
          status: (fields.status && fields.status.name) || '',
          priority: (fields.priority && fields.priority.name) || '',
          assignee: fields.assignee ? fields.assignee.displayName : 'Unassigned',
          reporter: fields.reporter ? fields.reporter.displayName : '',
          description: descText,
          labels: fields.labels || [],
          components: (fields.components || []).map((c) => c.name),
          fixVersions: (fields.fixVersions || []).map((v) => v.name),
          linkedIssues,
          confluenceLinks,
          created: fields.created || '',
          updated: fields.updated || '',
          isDemo: false,
        },
      };
    }

    // Confluence page context
    if (extension.content && extension.content.id) {
      const pageId = extension.content.id;
      const response = await asUser().requestConfluence(
        route`/wiki/rest/api/content/${pageId}?expand=body.storage,space,version,metadata.labels`,
        { headers: { Accept: 'application/json' } }
      );

      if (!response.ok) {
        console.warn(`Confluence API returned ${response.status} for ${pageId} — using demo data`);
        return { success: true, data: DEMO_PAGE_CONTEXT };
      }

      const page = await response.json();
      const bodyText = page.body && page.body.storage ? page.body.storage.value : '';
      const labels = page.metadata && page.metadata.labels
        ? page.metadata.labels.results.map((l) => l.name)
        : [];

      return {
        success: true,
        data: {
          pageId: page.id,
          title: page.title || '',
          spaceKey: page.space ? page.space.key : '',
          author: page.version && page.version.by ? page.version.by.displayName : '',
          lastModified: page.version ? page.version.when : '',
          excerpt: bodyText.replace(/<[^>]+>/g, ' ').slice(0, 500),
          labels,
          isDemo: false,
        },
      };
    }

    // No real context — return rich demo data
    return { success: true, data: DEMO_ISSUE_CONTEXT };
  } catch (err) {
    console.error('getContextData error:', err);
    return { success: true, data: DEMO_ISSUE_CONTEXT };
  }
});

/**
 * runContextAudit
 * Runs the full readiness scoring + AI content generation pipeline.
 */
resolver.define('runContextAudit', async (req) => {
  try {
    const { context: entityContext, auditType } = req.payload || {};

    if (!entityContext) {
      return { success: false, error: 'No context provided to audit.' };
    }

    const scoreResult = computeReadinessScore(entityContext);

    let generatedContent = '';
    if (auditType === 'acceptanceCriteria') {
      generatedContent = generateAcceptanceCriteria(entityContext);
    } else if (auditType === 'securityAudit') {
      generatedContent = generateSecurityAudit(entityContext);
    } else if (auditType === 'executiveBrief') {
      generatedContent = generateExecutiveBrief(entityContext, scoreResult);
    } else {
      // Full audit
      generatedContent =
        generateExecutiveBrief(entityContext, scoreResult) +
        '\n\n---\n\n' +
        generateSecurityAudit(entityContext) +
        '\n\n---\n\n## Generated Acceptance Criteria\n\n' +
        generateAcceptanceCriteria(entityContext);
    }

    return {
      success: true,
      score: scoreResult,
      generatedContent,
      auditType: auditType || 'full',
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error('runContextAudit error:', err);
    return { success: false, error: err.message };
  }
});

/**
 * saveAuditSnapshot
 * Persists a readiness audit to Forge Storage with a timestamp-keyed entry.
 */
resolver.define('saveAuditSnapshot', async (req) => {
  try {
    const { entityKey, snapshot } = req.payload || {};

    if (!entityKey || !snapshot) {
      return { success: false, error: 'entityKey and snapshot are required.' };
    }

    const timestamp = new Date().toISOString();
    const storageKey = `${STORAGE_AUDIT_PREFIX}${entityKey}_${timestamp.replace(/[:.]/g, '-')}`;

    const entry = {
      entityKey,
      timestamp,
      score: snapshot.score,
      flags: snapshot.flags || [],
      auditType: snapshot.auditType || 'full',
      summary: snapshot.summary || '',
      generatedContent: snapshot.generatedContent || '',
    };

    await storage.set(storageKey, entry);

    // Update index
    let index = (await storage.get(STORAGE_HISTORY_INDEX)) || [];
    index.unshift({ key: storageKey, entityKey, timestamp, score: entry.score });
    if (index.length > MAX_HISTORY_ENTRIES) {
      index = index.slice(0, MAX_HISTORY_ENTRIES);
    }
    await storage.set(STORAGE_HISTORY_INDEX, index);

    return { success: true, storageKey, timestamp };
  } catch (err) {
    console.error('saveAuditSnapshot error:', err);
    return { success: false, error: err.message };
  }
});

/**
 * getAuditHistory
 * Retrieves the index of saved audit snapshots, optionally filtered by entityKey.
 */
resolver.define('getAuditHistory', async (req) => {
  try {
    const { entityKey, limit = 10 } = req.payload || {};

    const index = (await storage.get(STORAGE_HISTORY_INDEX)) || [];
    const filtered = entityKey
      ? index.filter((entry) => entry.entityKey === entityKey)
      : index;

    const results = filtered.slice(0, limit);

    // Enrich with full snapshot data
    const enriched = await Promise.all(
      results.map(async (entry) => {
        const full = await storage.get(entry.key);
        return full || entry;
      })
    );

    return { success: true, history: enriched };
  } catch (err) {
    console.error('getAuditHistory error:', err);
    return { success: false, error: err.message, history: [] };
  }
});

// ─── Rovo Agent Action handlers ────────────────────────────────────────────────

/**
 * fetchIssueContext (Rovo action: fetch-issue-context)
 * Called by the ContextGuard Rovo Agent to retrieve structured issue context.
 */
resolver.define('fetchIssueContext', async (req) => {
  try {
    const { issueKey, pageId } = req.payload || {};

    if (issueKey) {
      const response = await asUser().requestJira(
        route`/rest/api/3/issue/${issueKey}?fields=summary,status,priority,assignee,description,labels,issuelinks`,
        { headers: { Accept: 'application/json' } }
      );

      if (!response.ok) {
        return {
          success: false,
          error: `Could not fetch issue ${issueKey}: HTTP ${response.status}`,
        };
      }

      const issue = await response.json();
      const fields = issue.fields || {};
      const scoreResult = computeReadinessScore({
        key: issue.key,
        summary: fields.summary || '',
        description: fields.description ? JSON.stringify(fields.description) : '',
        labels: fields.labels || [],
        linkedIssues: (fields.issuelinks || []).map((l) => ({
          key: (l.inwardIssue || l.outwardIssue || {}).key || '',
          type: l.type ? (l.inwardIssue ? l.type.inward : l.type.outward) : '',
        })),
        confluenceLinks: [],
      });

      return {
        success: true,
        issueKey: issue.key,
        summary: fields.summary,
        status: fields.status ? fields.status.name : '',
        priority: fields.priority ? fields.priority.name : '',
        readinessScore: scoreResult.total,
        flags: scoreResult.flags,
      };
    }

    if (pageId) {
      const response = await asUser().requestConfluence(
        route`/wiki/rest/api/content/${pageId}?expand=body.storage,space,version`,
        { headers: { Accept: 'application/json' } }
      );

      if (!response.ok) {
        return {
          success: false,
          error: `Could not fetch Confluence page ${pageId}: HTTP ${response.status}`,
        };
      }

      const page = await response.json();
      return {
        success: true,
        pageId: page.id,
        title: page.title,
        spaceKey: page.space ? page.space.key : '',
        lastModified: page.version ? page.version.when : '',
      };
    }

    return { success: false, error: 'Provide either issueKey or pageId.' };
  } catch (err) {
    console.error('fetchIssueContext error:', err);
    return { success: false, error: err.message };
  }
});

/**
 * logReadinessAudit (Rovo action: log-readiness-audit)
 * Called by the ContextGuard Rovo Agent to persist audit findings.
 */
resolver.define('logReadinessAudit', async (req) => {
  try {
    const { entityKey, score, findings, recommendation } = req.payload || {};

    if (!entityKey) {
      return { success: false, error: 'entityKey is required.' };
    }

    const timestamp = new Date().toISOString();
    const storageKey = `${STORAGE_AUDIT_PREFIX}rovo_${entityKey}_${timestamp.replace(/[:.]/g, '-')}`;

    const entry = {
      entityKey,
      timestamp,
      score: score || 0,
      findings: findings || [],
      recommendation: recommendation || '',
      source: 'rovo-agent',
    };

    await storage.set(storageKey, entry);

    // Update shared index
    let index = (await storage.get(STORAGE_HISTORY_INDEX)) || [];
    index.unshift({ key: storageKey, entityKey, timestamp, score: entry.score, source: 'rovo-agent' });
    if (index.length > MAX_HISTORY_ENTRIES) {
      index = index.slice(0, MAX_HISTORY_ENTRIES);
    }
    await storage.set(STORAGE_HISTORY_INDEX, index);

    return {
      success: true,
      message: `Audit logged for ${entityKey} with score ${score}/100.`,
      storageKey,
      timestamp,
    };
  } catch (err) {
    console.error('logReadinessAudit error:', err);
    return { success: false, error: err.message };
  }
});

// ─── Export handler ────────────────────────────────────────────────────────────

exports.handler = resolver.getDefinitions();
