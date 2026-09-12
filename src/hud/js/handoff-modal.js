/**
 * src/hud/js/handoff-modal.js
 * VibeSync Human Handoff Card Modal Component
 */

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

export function renderHandoffCardVisual(card, modalEl) {
  if (!card || !modalEl) return;

  const metaBox = modalEl.querySelector('#handoff-meta-box');
  const changesBox = modalEl.querySelector('#handoff-changes-box');
  const whyBox = modalEl.querySelector('#handoff-why-box');
  const evidenceBox = modalEl.querySelector('#handoff-evidence-box');
  const risksBox = modalEl.querySelector('#handoff-risks-box');
  const nextActionBox = modalEl.querySelector('#handoff-next-action');
  const ejectBtn = modalEl.querySelector('#handoff-eject-btn');

  // 1. Meta & Telemetry Box
  if (metaBox) {
    const task = card.task || {};
    const feature = card.feature || {};
    const leaseRemaining = card.leaseRemainingSeconds != null 
      ? (card.leaseRemainingSeconds > 0 ? `${card.leaseRemainingSeconds}s remaining` : 'Expired')
      : 'None';

    metaBox.innerHTML = `
      <div class="handoff-meta-grid">
        <div class="handoff-meta-item">
          <span class="label">Task</span>
          <span class="val">${escapeHtml(task.id)}: ${escapeHtml(task.title)}</span>
        </div>
        <div class="handoff-meta-item">
          <span class="label">Status</span>
          <span class="val"><span class="badge badge-${escapeHtml(task.status)}">${escapeHtml(task.status)}</span></span>
        </div>
        <div class="handoff-meta-item">
          <span class="label">Assigned Actor</span>
          <span class="val">${escapeHtml(task.assigned_actor || 'unassigned')}</span>
        </div>
        <div class="handoff-meta-item">
          <span class="label">Active Lease</span>
          <span class="val">${escapeHtml(leaseRemaining)} (Gen ${task.lease_generation || 0})</span>
        </div>
        <div class="handoff-meta-item">
          <span class="label">Circuit Breaker</span>
          <span class="val" style="${task.consecutive_failures > 0 ? 'color:var(--red); font-weight:700;' : ''}">${task.consecutive_failures || 0} / ${task.max_failures || 3} failures</span>
        </div>
        <div class="handoff-meta-item">
          <span class="label">Feature</span>
          <span class="val">${escapeHtml(feature.id ? `${feature.id}: ${feature.title}` : (task.feature_id || 'None'))}</span>
        </div>
      </div>
    `;
  }

  // 2. What Changed
  if (changesBox) {
    const changes = card.changes || { modified: [], untracked: [], diffstat: '' };
    const worktreePath = card.worktreePath || 'Not provisioned';
    changesBox.innerHTML = `
      <div><strong>Worktree:</strong> <code>${escapeHtml(worktreePath)}</code></div>
      <div style="margin-top:4px;"><strong>Modified files (${changes.modified.length}):</strong> ${changes.modified.length > 0 ? changes.modified.map(f => `<code>${escapeHtml(f)}</code>`).join(', ') : '<em>None</em>'}</div>
      <div style="margin-top:2px;"><strong>Untracked files (${changes.untracked.length}):</strong> ${changes.untracked.length > 0 ? changes.untracked.map(f => `<code>${escapeHtml(f)}</code>`).join(', ') : '<em>None</em>'}</div>
      ${changes.diffstat ? `<div style="margin-top:4px; font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${escapeHtml(changes.diffstat.split('\n')[0])}</div>` : ''}
    `;
  }

  // 3. Why (Contract Goal)
  if (whyBox) {
    const task = card.task || {};
    const allowed = Array.isArray(task.allowed_paths) ? task.allowed_paths.join(', ') : (task.allowed_paths || '*');
    whyBox.innerHTML = `
      <div><strong>Goal:</strong> ${escapeHtml(task.title || '')}</div>
      <div style="margin-top:3px;"><strong>Allowed Paths:</strong> <code>${escapeHtml(allowed)}</code></div>
      ${card.feature?.spec_markdown ? `<div style="margin-top:4px; color:var(--text-muted); font-size:11px;"><em>${escapeHtml(card.feature.spec_markdown.trim().split('\n')[0].slice(0, 120))}...</em></div>` : ''}
    `;
  }

  // 4. Evidence (Gates & Verification)
  if (evidenceBox) {
    const gates = card.requiredGates || [];
    const runs = card.gateRuns || [];
    evidenceBox.innerHTML = `
      <div><strong>Required Gates:</strong> ${gates.length > 0 ? gates.map(g => `<code>${escapeHtml(g.command || g)}</code>`).join(' &nbsp; ') : '<em>None required</em>'}</div>
      <div style="margin-top:6px; display:flex; flex-direction:column; gap:3px;">
        ${runs.length > 0
          ? runs.slice(0, 5).map(r => `
            <div style="display:flex; justify-content:space-between; font-size:11px; font-family:var(--font-mono);">
              <span style="color:${r.status === 'passed' ? 'var(--green)' : 'var(--red)'}; font-weight:700;">[${escapeHtml((r.status || '').toUpperCase())}] exit ${r.exit_code ?? 0}</span>
              <span style="color:var(--text-muted);">${r.duration_ms || 0}ms</span>
              <span style="flex:1; margin-left:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(r.summary || 'gate run')}</span>
            </div>`).join('')
          : '<div style="color:var(--text-muted); font-size:11px;">No gate runs recorded yet.</div>'
        }
      </div>
    `;
  }

  // 5. Risks & Rollback
  if (risksBox) {
    const drift = card.drift;
    const rollback = card.rollback || {};
    const driftText = drift 
      ? (drift.behind_trunk === 0 ? 'Clean (0 commits behind trunk)' : `${drift.behind_trunk} commits behind trunk (${drift.warning || 'drift'})`)
      : 'No worktree drift inspected';

    risksBox.innerHTML = `
      <div><strong>Drift from trunk:</strong> ${escapeHtml(driftText)}</div>
      <div style="margin-top:3px;"><strong>Recovery Branch:</strong> <code>${escapeHtml(rollback.branch || 'None')}</code> (Base: <code>${escapeHtml((rollback.baseCommit || 'HEAD').slice(0, 7))}</code>)</div>
    `;
  }

  // 6. Next Action
  if (nextActionBox) {
    nextActionBox.textContent = card.nextAction || 'Continue regular task lifecycle.';
  }

  // 7. Eject Button visibility
  if (ejectBtn) {
    const task = card.task || {};
    const canEject = task.status === 'in_progress' || (task.assigned_actor && task.assigned_actor !== 'human');
    ejectBtn.style.display = canEject ? 'inline-block' : 'none';
  }
}
