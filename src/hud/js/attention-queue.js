/**
 * src/hud/js/attention-queue.js
 * VibeSync Calm Operations Attention Queue Component
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

export function renderAttentionQueue(queue, containerEl, { onOpenHandoff, onFilterStatus } = {}) {
  if (!containerEl) return;
  if (!queue || !queue.summary) {
    containerEl.style.display = 'none';
    return;
  }

  containerEl.style.display = 'block';
  const cardEl = containerEl.querySelector('.attention-queue-card') || containerEl;
  const headlineEl = containerEl.querySelector('#attention-headline');
  const actionBtn = containerEl.querySelector('#attention-action-btn');

  const pillDecisions = containerEl.querySelector('#pill-decisions');
  const pillReviews = containerEl.querySelector('#pill-reviews');
  const pillBlocked = containerEl.querySelector('#pill-blocked');
  const pillActive = containerEl.querySelector('#pill-active');

  const { total, decisionsCount, reviewsCount, blockedCount, inProgressCount } = queue.summary;

  // Render Pills
  if (pillDecisions) {
    pillDecisions.style.display = decisionsCount > 0 ? 'inline-flex' : 'none';
    pillDecisions.textContent = `🚨 ${decisionsCount} Decision${decisionsCount === 1 ? '' : 's'}`;
    pillDecisions.onclick = () => onFilterStatus && onFilterStatus('blocked');
  }

  if (pillReviews) {
    pillReviews.style.display = reviewsCount > 0 ? 'inline-flex' : 'none';
    pillReviews.textContent = `👀 ${reviewsCount} Review${reviewsCount === 1 ? '' : 's'}`;
    pillReviews.onclick = () => onFilterStatus && onFilterStatus('review');
  }

  if (pillBlocked) {
    pillBlocked.style.display = blockedCount > 0 ? 'inline-flex' : 'none';
    pillBlocked.textContent = `⛔ ${blockedCount} Blocked`;
    pillBlocked.onclick = () => onFilterStatus && onFilterStatus('blocked');
  }

  if (pillActive) {
    pillActive.style.display = inProgressCount > 0 ? 'inline-flex' : 'none';
    pillActive.textContent = `⚡ ${inProgressCount} Active`;
    pillActive.onclick = () => onFilterStatus && onFilterStatus('in_progress');
  }

  // Render Headline & Action Button
  if (total === 0 || (!decisionsCount && !reviewsCount && !blockedCount && !inProgressCount)) {
    cardEl.classList.remove('has-alerts');
    cardEl.classList.add('calm');
    if (headlineEl) {
      headlineEl.textContent = 'All clear — zero blocked tasks or pending decisions. Agents operating autonomously.';
    }
    if (actionBtn) actionBtn.style.display = 'none';
  } else {
    if (decisionsCount > 0 || blockedCount > 0) {
      cardEl.classList.remove('calm');
      cardEl.classList.add('has-alerts');
    } else {
      cardEl.classList.remove('has-alerts', 'calm');
    }

    if (queue.topAction) {
      const { category, title, action, taskId } = queue.topAction;
      if (headlineEl) {
        headlineEl.innerHTML = `<strong>${escapeHtml(category.toUpperCase())}:</strong> ${escapeHtml(title)} &mdash; <span style="color:var(--text-muted);">${escapeHtml(action)}</span>`;
      }
      if (actionBtn) {
        actionBtn.style.display = 'inline-block';
        actionBtn.textContent = category === 'decision' ? '🚨 Intervene' : '📋 Inspect Handoff';
        actionBtn.onclick = () => onOpenHandoff && onOpenHandoff(taskId);
      }
    } else if (headlineEl) {
      headlineEl.textContent = `${total} item${total === 1 ? '' : 's'} in queue.`;
      if (actionBtn) actionBtn.style.display = 'none';
    }
  }
}
