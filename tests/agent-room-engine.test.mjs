/**
 * tests/agent-room-engine.test.mjs
 * 
 * VibeSync Pixel Agent Room & Multi-Agent Teamwork Verification Suite
 * Milestone 6: Dynamic Multi-Agent Pixel Teamwork Visualization (R1 & R2, AC 1–4)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { synthesizeAgents, getPayload } from '../src/server.mjs';

function createMockContext2D() {
  const calls = [];
  return {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    globalAlpha: 1.0,
    fillRect(x, y, w, h) {
      calls.push({ fn: 'fillRect', x, y, w, h, fillStyle: this.fillStyle, alpha: this.globalAlpha });
    },
    strokeRect(x, y, w, h) {
      calls.push({ fn: 'strokeRect', x, y, w, h, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth });
    },
    fillText(text, x, y) {
      calls.push({ fn: 'fillText', text, x, y, fillStyle: this.fillStyle, font: this.font, textAlign: this.textAlign });
    },
    beginPath() { calls.push({ fn: 'beginPath' }); },
    moveTo(x, y) { calls.push({ fn: 'moveTo', x, y }); },
    lineTo(x, y) { calls.push({ fn: 'lineTo', x, y }); },
    stroke() { calls.push({ fn: 'stroke', strokeStyle: this.strokeStyle }); },
    fill() { calls.push({ fn: 'fill', fillStyle: this.fillStyle, alpha: this.globalAlpha }); },
    clearRect(x, y, w, h) { calls.push({ fn: 'clearRect', x, y, w, h }); },
    save() { calls.push({ fn: 'save' }); },
    restore() { calls.push({ fn: 'restore' }); },
    translate(x, y) { calls.push({ fn: 'translate', x, y }); }
  };
}

function setupEngineTestBed() {
  const htmlPath = path.resolve(process.cwd(), '.vibesync', 'dashboard.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'dashboard.html must contain script element');
  const script = scriptMatch[1];

  const ctx = createMockContext2D();
  const listeners = {};
  const mockCanvas = {
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 920, height: 155 }),
    addEventListener: (event, handler) => { listeners[event] = handler; }
  };

  const domElements = {
    'agent-room-canvas': mockCanvas,
    'room-speech-bubble': { style: {}, textContent: '' },
    'room-mining-status': { style: {}, textContent: '' },
    'thought-modal-title': { innerHTML: '', textContent: '' },
    'thought-modal-body': { innerHTML: '', textContent: '' },
    'thought-modal-footer': { innerHTML: '', textContent: '' },
    'agent-thoughts-modal': { querySelector: () => null, style: {}, classList: { add() {}, remove() {}, toggle() {} } }
  };

  const sandbox = {
    window: {},
    location: { protocol: 'http:', search: '' },
    document: {
      documentElement: {
        setAttribute() {},
        getAttribute() { return null; }
      },
      getElementById: (id) => domElements[id] || {
        style: {},
        textContent: '',
        innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {} }
      },
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => null
    },
    performance: { now: () => 1000 },
    requestAnimationFrame: () => {},
    setTimeout: (fn) => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    console
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  const AgentRoomEngine = vm.runInContext('AgentRoomEngine', sandbox);
  const engine = new AgentRoomEngine('agent-room-canvas');

  return { engine, ctx, domElements, listeners, sandbox };
}

test('Pixel Agent Room Multi-Agent Teamwork Suite (Milestone 6)', async (t) => {

  await t.test('Server-Side getPayload and synthesizeAgents dynamic role mapping (R1 & AC 1)', () => {
    const syntheticTasks = [
      { id: 'TASK-LEAD', title: 'Plan Features', status: 'in_progress', assigned_actor: 'gemini-antigravity', branch_name: 'task/lead' },
      { id: 'TASK-IMP', title: 'Implement Module', status: 'in_progress', assigned_actor: 'openai-codex', branch_name: 'task/imp' },
      { id: 'TASK-REV', title: 'Audit and Verify', status: 'review', assigned_actor: 'anthropic-claude', branch_name: 'task/rev' },
      { id: 'TASK-JUDGE', title: 'Judicial Settlement', status: 'ready', assigned_actor: 'human', branch_name: 'task/judge' }
    ];

    const agents = synthesizeAgents(syntheticTasks, [], []);
    assert.equal(agents.length, 4, 'Must synthesize exactly 4 subagent roles');

    // Slot 0: Team Lead
    assert.equal(agents[0].role, 'Team Lead');
    assert.equal(agents[0].deskSlot, 0);
    assert.equal(agents[0].color, '#06b6d4');
    assert.equal(agents[0].state, 'working');
    assert.equal(agents[0].activeTask.id, 'TASK-LEAD');

    // Slot 1: Implementer
    assert.equal(agents[1].role, 'Implementer');
    assert.equal(agents[1].deskSlot, 1);
    assert.equal(agents[1].color, '#10b981');
    assert.equal(agents[1].state, 'working');
    assert.equal(agents[1].activeTask.id, 'TASK-IMP');

    // Slot 2: Reviewer
    assert.equal(agents[2].role, 'Reviewer');
    assert.equal(agents[2].deskSlot, 2);
    assert.equal(agents[2].color, '#c084fc');
    assert.equal(agents[2].state, 'verifying');
    assert.equal(agents[2].activeTask.id, 'TASK-REV');

    // Slot 3: Judge
    assert.equal(agents[3].role, 'Judge');
    assert.equal(agents[3].deskSlot, 3);
    assert.equal(agents[3].color, '#f59e0b');
    assert.equal(agents[3].state, 'idle');
  });

  await t.test('Acceptance Criterion 1: Task lease seats agent at desk with monitor activity & branch pill', () => {
    const { engine, ctx } = setupEngineTestBed();

    engine.updateFromState({
      tasks: [{
        id: 'TASK-01.1',
        title: 'Build Core Engine',
        status: 'in_progress',
        assigned_actor: 'openai-codex',
        branch_name: 'task/task-01-1'
      }]
    });

    const implementer = engine.agents.implementer;
    assert.ok(implementer, 'Implementer agent must exist in engine');
    assert.equal(implementer.state, 'working', 'Leased task must transition agent to working state');
    assert.equal(implementer.activeTask, 'TASK-01.1');

    // Backward compatibility alias check
    assert.equal(engine.agents.codex.state, 'working', 'codex alias must match implementer state');
    assert.equal(engine.agents.codex.chairX, implementer.chairX);

    // Seated at workstation chair, NOT resting in lounge
    const pos = engine.getAgentPos(implementer, 0);
    assert.equal(pos.x, implementer.chairX, 'Agent X must match chairX');
    assert.equal(pos.y, 104, 'Agent Y must match seated height 104');
    assert.notEqual(pos.x, implementer.restX, 'Seated agent must not be in break lounge');

    // Render frame and verify monitor activity & overhead pills
    ctx.calls.length = 0;
    engine.render(0);

    // 1. Task ID pill
    const taskPill = ctx.calls.find(c => c.fn === 'fillText' && c.text === 'TASK-01.1');
    assert.ok(taskPill, 'Must render overhead task pill with TASK-01.1');

    // 2. Monospace branch name pill
    const branchPill = ctx.calls.find(c => c.fn === 'fillText' && c.text === 'task/task-01-1');
    assert.ok(branchPill, 'Must render overhead branch pill with task/task-01-1');

    // 3. Monitor activity: scrolling code lines in agent color
    const codeLines = ctx.calls.filter(c => c.fn === 'fillRect' && c.fillStyle === implementer.color && c.h === 2);
    assert.ok(codeLines.length >= 4, 'Must render animated scrolling code lines in agent color');

    // 4. Projection light cone
    const hasLightCone = ctx.calls.some(c => c.fn === 'fill' && c.alpha === 0.12);
    assert.ok(hasLightCone, 'Must render ambient monitor light cone with transparency');

    // 5. Secondary monitor sparkline
    const sparkline = ctx.calls.some(c => c.fn === 'stroke' && c.strokeStyle === '#34d399');
    assert.ok(sparkline, 'Must render secondary monitor sparkline in green');
  });

  await t.test('Acceptance Criterion 2: Verification gate state moves agent to server rack with intensified LEDs', () => {
    const { engine, ctx } = setupEngineTestBed();

    engine.updateFromState({
      tasks: [{
        id: 'TASK-02.1',
        title: 'Shift-Left Gate Verification',
        status: 'review',
        assigned_actor: 'anthropic-claude',
        branch_name: 'task/task-02-1'
      }]
    });

    const reviewer = engine.agents.reviewer;
    assert.ok(reviewer, 'Reviewer agent must exist in engine');
    assert.equal(reviewer.state, 'verifying', 'Review status must transition reviewer to verifying state');

    // Position: moves to server rack at rackX: 180, rackY: 104
    const pos = engine.getAgentPos(reviewer, 0);
    assert.equal(pos.x, 180, 'Agent must move to server rack position X = 180');
    assert.equal(pos.y, 104, 'Agent must stand at server rack position Y = 104');

    // Render frame
    ctx.calls.length = 0;
    engine.render(0);

    // 1. Server rack marquee displaying 'VERIFYING GATES ⚡'
    const marquee = ctx.calls.find(c => c.fn === 'fillText' && c.text === 'VERIFYING GATES ⚡');
    assert.ok(marquee, "Server rack marquee must display 'VERIFYING GATES ⚡'");

    // 2. High-speed verification scan LEDs
    const cyanLeds = ctx.calls.filter(c => c.fn === 'fillRect' && c.fillStyle === '#38bdf8' && c.w === 3 && c.h === 3);
    assert.ok(cyanLeds.length > 0, 'Server rack must render intensified scan LEDs in verification mode');

    // 3. Diagnostics tablet held by agent at rack
    const tabletScreen = ctx.calls.filter(c => c.fn === 'fillRect' && c.fillStyle === '#38bdf8' && c.w === 5 && c.h === 7);
    assert.ok(tabletScreen.length > 0, 'Agent sprite must render diagnostics tablet screen at server rack');
  });

  await t.test('Acceptance Criterion 3: Tripped circuit breaker renders flashing hazard beacon above desk', () => {
    const { engine, ctx } = setupEngineTestBed();

    engine.updateFromState({
      tasks: [{
        id: 'TASK-03.1',
        title: 'Failing Regression Task',
        status: 'blocked',
        consecutive_failures: 3,
        assigned_actor: 'openai-codex',
        branch_name: 'task/task-03-1'
      }]
    });

    const implementer = engine.agents.implementer;
    assert.equal(implementer.state, 'blocked', 'Blocked task must transition agent state to blocked');
    assert.equal(implementer.hazardBeacon, true, 'hazardBeacon flag must be set to true');

    // Seated at desk
    const pos = engine.getAgentPos(implementer, 0);
    assert.equal(pos.x, implementer.chairX, 'Blocked agent remains seated at desk');

    // Render frame
    ctx.calls.length = 0;
    engine.render(0);

    // 1. Warning banner displaying '🚨 3 STRIKES BLOCKED'
    const warningBanner = ctx.calls.find(c => c.fn === 'fillText' && c.text === '🚨 3 STRIKES BLOCKED');
    assert.ok(warningBanner, "Must render '🚨 3 STRIKES BLOCKED' warning banner directly above desk");

    // 2. Siren red dome (#ef4444)
    const redDome = ctx.calls.find(c => c.fn === 'fillRect' && c.fillStyle === '#ef4444' && c.w === 10 && c.h === 10);
    assert.ok(redDome, 'Must render red siren dome for hazard beacon');

    // 3. Mounting bracket (#334155)
    const bracket = ctx.calls.find(c => c.fn === 'fillRect' && c.fillStyle === '#334155' && c.w === 8 && c.h === 4);
    assert.ok(bracket, 'Must render mounting bracket directly above desk');

    // 4. Rotating strobe light cone
    const hasStrobeCone = ctx.calls.some(c => c.fn === 'fill' && typeof c.fillStyle === 'string' && c.fillStyle.includes('rgba(239, 68, 68'));
    assert.ok(hasStrobeCone, 'Must render flashing rotating strobe light cone');

    // 5. Red alert monitor screen (#7f1d1d)
    const redMonitor = ctx.calls.find(c => c.fn === 'fillRect' && c.fillStyle === '#7f1d1d' && c.w === 32 && c.h === 18);
    assert.ok(redMonitor, 'Monitor must show red alert screen on tripped circuit breaker');
  });

  await t.test('Acceptance Criterion 4: Canvas click on agent displays modal with leased task ID, branch, and embedded logs', () => {
    const { engine, domElements, listeners } = setupEngineTestBed();

    engine.updateFromState({
      tasks: [{
        id: 'TASK-04.1',
        title: 'Judicial Enforcement',
        status: 'in_progress',
        branch_name: 'task/task-04-1',
        assigned_actor: 'openai-codex'
      }]
    });

    // Simulate click at implementer workstation
    const implementerPos = engine.getAgentPos(engine.agents.implementer, 0);
    listeners.click({ clientX: implementerPos.x, clientY: implementerPos.y });

    const titleHtml = domElements['thought-modal-title'].innerHTML;
    const bodyHtml = domElements['thought-modal-body'].innerHTML;

    // 1. Current Leased Task ID
    assert.ok(bodyHtml.includes('TASK-04.1'), 'Modal body must directly display current leased Task ID');

    // 2. Leased Branch Name
    assert.ok(bodyHtml.includes('task/task-04-1'), 'Modal body must directly display worktree branch');

    // 3. Role badge
    assert.ok(bodyHtml.includes('Implementer'), 'Modal body must display subagent role badge');

    // 4. Integrated scrollable terminal box directly embedding logs
    assert.ok(bodyHtml.includes('agent-modal-logs-box'), 'Modal must contain integrated terminal logs box');
    assert.ok(bodyHtml.includes('Verification &amp; Gatekeeper Logs') || bodyHtml.includes('Verification & Gatekeeper Logs'), 'Modal must include gatekeeper logs header');
    assert.ok(bodyHtml.includes('Loading recorded verification logs'), 'Terminal must show loading until evidence arrives');
    assert.ok(!bodyHtml.includes('exit code 0'), 'Inspector must never fabricate passing gates');

    // 5. Hit testing verification across all room zones
    // 5a. Click at server rack when agent is verifying
    engine.updateFromState({
      tasks: [{ id: 'TASK-RACK', title: 'Rack Verifier', status: 'review', branch_name: 'task/rack', assigned_actor: 'claude' }]
    });
    listeners.click({ clientX: 180, clientY: 104 });
    assert.ok(domElements['thought-modal-body'].innerHTML.includes('TASK-RACK'), 'Clicking server rack zone must hit-test verifying agent');

    // 5b. Click in lounge when agent is idle
    engine.updateFromState({ tasks: [] });
    listeners.click({ clientX: 740, clientY: 108 });
    assert.ok(domElements['thought-modal-title'].innerHTML.includes('Team Lead'), 'Clicking lounge zone must hit-test idle agent');
  });

});
