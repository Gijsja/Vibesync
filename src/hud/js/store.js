/**
 * src/hud/js/store.js
 * VibeSync Reactive HUD State Store
 */

export class HudStore {
  constructor(apiBase = '') {
    this.apiBase = apiBase;
    this.state = null;
    this.listeners = new Set();
    this.connectionListeners = new Set();
    this.eventSource = null;
    this.connected = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    if (this.state) listener(this.state);
    return () => this.listeners.delete(listener);
  }

  onConnection(listener) {
    this.connectionListeners.add(listener);
    listener(this.connected);
    return () => this.connectionListeners.delete(listener);
  }

  setState(newState) {
    this.state = newState;
    for (const listener of this.listeners) {
      try { listener(this.state); } catch (e) { console.error('Error in HUD store listener:', e); }
    }
  }

  setConnected(status) {
    if (this.connected === status) return;
    this.connected = status;
    for (const listener of this.connectionListeners) {
      try { listener(this.connected); } catch (e) { console.error('Error in HUD connection listener:', e); }
    }
  }

  connectSse() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    const sseUrl = `${this.apiBase}/api/events`;
    this.eventSource = new EventSource(sseUrl);

    this.eventSource.onopen = () => {
      this.setConnected(true);
    };

    this.eventSource.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        this.setState(payload);
      } catch (err) {
        console.error('Failed to parse SSE payload:', err);
      }
    };

    this.eventSource.onerror = () => {
      this.setConnected(false);
    };
  }

  async fetchSnapshot() {
    try {
      const res = await fetch(`${this.apiBase}/api/state`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.setState(data);
      this.setConnected(true);
      return data;
    } catch (err) {
      this.setConnected(false);
      throw err;
    }
  }

  async fetchAttentionQueue() {
    const res = await fetch(`${this.apiBase}/api/queue`);
    if (!res.ok) throw new Error(`Failed to fetch attention queue: HTTP ${res.status}`);
    return await res.json();
  }

  async fetchHandoffCard(taskId, format = 'json') {
    const url = taskId 
      ? `${this.apiBase}/api/handoff/${encodeURIComponent(taskId)}?format=${encodeURIComponent(format)}`
      : `${this.apiBase}/api/handoff?format=${encodeURIComponent(format)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch handoff card: HTTP ${res.status}`);
    if (format === 'markdown' || format === 'text') {
      return await res.text();
    }
    return await res.json();
  }

  async ejectTask(taskId) {
    const res = await fetch(`${this.apiBase}/api/tasks/${encodeURIComponent(taskId)}/eject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || 'Failed to eject task');
    }
    return await res.json();
  }
}
