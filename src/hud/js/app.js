/**
 * src/hud/js/app.js
 * VibeSync Browser-Native HUD Bootstrap
 */

import { HudStore } from './store.js';
import { renderAttentionQueue } from './attention-queue.js';
import { renderHandoffCardVisual } from './handoff-modal.js';

export class VibesyncHudApp {
  constructor(apiBase = '') {
    this.store = new HudStore(apiBase);
    this.currentHandoffTaskId = null;
    this.currentHandoffData = null;
    this.currentHandoffText = '';
    this.handoffViewMode = 'visual';
  }

  init() {
    // Subscribe store to state updates
    this.store.subscribe((state) => {
      this.onStateUpdate(state);
    });

    // Start SSE stream
    this.store.connectSse();
  }

  onStateUpdate(state) {
    if (!state) return;
    const queueSection = document.getElementById('attention-queue-section');
    if (queueSection && state.attentionQueue) {
      renderAttentionQueue(state.attentionQueue, queueSection, {
        onOpenHandoff: (taskId) => this.openHandoffModal(taskId),
        onFilterStatus: (status) => {
          if (typeof window.setFilter === 'function') {
            window.setFilter(status);
          }
        }
      });
    }
  }

  async openHandoffModal(taskId = null) {
    const modal = document.getElementById('handoff-modal');
    if (!modal) return;

    const state = this.store.state;
    const tasks = state?.tasks || [];
    
    // Select priority task if none provided
    if (!taskId) {
      if (state?.attentionQueue?.topAction?.taskId) {
        taskId = state.attentionQueue.topAction.taskId;
      } else {
        const active = tasks.find(t => t.status === 'in_progress' || t.status === 'blocked');
        taskId = active ? active.id : (tasks[0]?.id || null);
      }
    }

    this.currentHandoffTaskId = taskId;

    // Populate select
    const select = document.getElementById('handoff-task-select');
    if (select) {
      select.innerHTML = tasks.length === 0
        ? '<option value="">No tasks available</option>'
        : tasks.map(t => `<option value="${t.id}" ${t.id === taskId ? 'selected' : ''}>${t.id}: ${t.title} (${t.status})</option>`).join('');
    }

    if (typeof window.openModal === 'function') {
      window.openModal('handoff-modal');
    } else {
      modal.style.display = 'flex';
    }

    if (taskId) {
      await this.loadHandoffTask(taskId);
    }
  }

  async loadHandoffTask(taskId) {
    this.currentHandoffTaskId = taskId;
    const rawPre = document.getElementById('handoff-raw-text');
    if (rawPre) rawPre.textContent = 'Loading handoff data…';

    try {
      const [cardData, cardText] = await Promise.all([
        this.store.fetchHandoffCard(taskId, 'json'),
        this.store.fetchHandoffCard(taskId, 'text')
      ]);

      this.currentHandoffData = cardData;
      this.currentHandoffText = cardText;

      const modal = document.getElementById('handoff-modal');
      if (modal) {
        renderHandoffCardVisual(cardData, modal);
      }
      if (rawPre) {
        rawPre.textContent = cardText;
      }
    } catch (err) {
      if (rawPre) rawPre.textContent = `Error loading handoff card: ${err.message}`;
    }
  }

  setHandoffView(mode) {
    this.handoffViewMode = mode;
    const visualBox = document.getElementById('handoff-visual-content');
    const rawBox = document.getElementById('handoff-raw-content');
    const visualBtn = document.getElementById('handoff-view-visual');
    const rawBtn = document.getElementById('handoff-view-raw');

    if (mode === 'visual') {
      if (visualBox) visualBox.style.display = 'flex';
      if (rawBox) rawBox.style.display = 'none';
      if (visualBtn) visualBtn.classList.add('active');
      if (rawBtn) rawBtn.classList.remove('active');
    } else {
      if (visualBox) visualBox.style.display = 'none';
      if (rawBox) rawBox.style.display = 'block';
      if (visualBtn) visualBtn.classList.remove('active');
      if (rawBtn) rawBtn.classList.add('active');
    }
  }

  async ejectCurrentTask() {
    if (!this.currentHandoffTaskId) return;
    if (typeof window.confirmAction === 'function') {
      const ok = await window.confirmAction(`⚠️ Eject agent lease on ${this.currentHandoffTaskId} and reassign directly to human overseer?`);
      if (!ok) return;
    }
    try {
      await this.store.ejectTask(this.currentHandoffTaskId);
      if (typeof window.notifyUser === 'function') {
        window.notifyUser(`Task ${this.currentHandoffTaskId} ejected to human.`);
      }
      await this.loadHandoffTask(this.currentHandoffTaskId);
    } catch (err) {
      if (typeof window.notifyError === 'function') {
        window.notifyError(`Failed to eject task: ${err.message}`);
      }
    }
  }

  copyHandoffText() {
    if (!this.currentHandoffText) return;
    if (typeof window.copyToClipboard === 'function') {
      window.copyToClipboard(this.currentHandoffText, 'Handoff card copied to clipboard!');
    } else {
      navigator.clipboard.writeText(this.currentHandoffText);
    }
  }
}
