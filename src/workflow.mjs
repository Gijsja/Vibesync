/**
 * Build client-side Mermaid definitions for the live workflow HUD and feature cards.
 * 1. Active Work Pipeline (flowchart LR) for the main ambient HUD.
 * 2. Feature Task Execution DAG (flowchart LR) with real dependency tracking for feature cards.
 */

const STATUS_ORDER = ['backlog', 'ready', 'in_progress', 'verifying', 'review', 'settled', 'blocked'];

const LANE_TITLES = {
  backlog: 'Backlog',
  ready: 'Ready to Claim',
  in_progress: 'In Progress',
  verifying: 'Verifying',
  review: 'Review',
  settled: 'Settled',
  blocked: 'Blocked / Attention'
};

const STATUS_ICONS = {
  settled: '✓ settled',
  in_progress: '⚡ in progress',
  verifying: '🔍 verifying',
  review: '👀 review',
  ready: '⏳ ready',
  blocked: '⚠️ blocked',
  backlog: '📋 backlog'
};

const PALETTES = {
  light: {
    feature: ['#e0f2fe', '#0284c7', '#0369a1'],
    backlog: ['#f8fafc', '#94a3b8', '#334155'],
    ready: ['#f8fafc', '#94a3b8', '#0f172a'],
    in_progress: ['#eff6ff', '#3b82f6', '#1e40af'],
    verifying: ['#faf5ff', '#a855f7', '#6b21a8'],
    review: ['#fffbeb', '#f59e0b', '#92400e'],
    settled: ['#f0fdf4', '#22c55e', '#15803d'],
    blocked: ['#fef2f2', '#ef4444', '#b91c1c'],
    endpoint: ['#f8fafc', '#64748b', '#334155']
  },
  dark: {
    feature: ['#082f49', '#38bdf8', '#e0f2fe'],
    backlog: ['#1e293b', '#64748b', '#cbd5e1'],
    ready: ['#0f172a', '#64748b', '#f8fafc'],
    in_progress: ['#0c2340', '#0284c7', '#bfdbfe'],
    verifying: ['#231045', '#7e22ce', '#e9d5ff'],
    review: ['#331402', '#b45309', '#fde68a'],
    settled: ['#04200f', '#15803d', '#bbf7d0'],
    blocked: ['#300707', '#b91c1c', '#fecaca'],
    endpoint: ['#1e293b', '#64748b', '#cbd5e1']
  }
};

const SUBGRAPH_STYLES = {
  light: {
    ready: 'fill:#f8fafc,stroke:#cbd5e1,stroke-width:1.5px,color:#334155',
    in_progress: 'fill:#f0f9ff,stroke:#bae6fd,stroke-width:1.5px,color:#1e40af',
    verifying: 'fill:#faf5ff,stroke:#f3e8ff,stroke-width:1.5px,color:#6b21a8',
    review: 'fill:#fffbeb,stroke:#fef3c7,stroke-width:1.5px,color:#92400e',
    settled: 'fill:#f0fdf4,stroke:#dcfce7,stroke-width:1.5px,color:#166534',
    blocked: 'fill:#fef2f2,stroke:#fee2e2,stroke-width:1.5px,color:#991b1b',
    backlog: 'fill:#f8fafc,stroke:#e2e8f0,stroke-width:1.5px,color:#475569'
  },
  dark: {
    ready: 'fill:#0f172a,stroke:#334155,stroke-width:1.5px,color:#cbd5e1',
    in_progress: 'fill:#0c2340,stroke:#0369a1,stroke-width:1.5px,color:#93c5fd',
    verifying: 'fill:#231045,stroke:#6b21a8,stroke-width:1.5px,color:#d8b4fe',
    review: 'fill:#331402,stroke:#92400e,stroke-width:1.5px,color:#fde68a',
    settled: 'fill:#04200f,stroke:#166534,stroke-width:1.5px,color:#86efac',
    blocked: 'fill:#300707,stroke:#991b1b,stroke-width:1.5px,color:#fca5a5',
    backlog: 'fill:#1e293b,stroke:#334155,stroke-width:1.5px,color:#94a3b8'
  }
};

function quoted(value) {
  return JSON.stringify(String(value ?? '').replace(/[\r\n]+/g, ' ').trim());
}

function truncate(str, maxLen = 28) {
  const s = String(str ?? '').trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

function wrapTitle(str, maxPerLine = 24, maxLines = 2) {
  const words = String(str ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'Untitled';
  const lines = [];
  let current = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!current) {
      current = w;
    } else if ((current + ' ' + w).length <= maxPerLine) {
      current += ' ' + w;
    } else {
      lines.push(current);
      current = w;
      if (lines.length === maxLines - 1) {
        for (let j = i + 1; j < words.length; j++) {
          const nextW = words[j];
          if ((current + ' ' + nextW).length <= maxPerLine - 2) {
            current += ' ' + nextW;
          } else {
            current += '…';
            break;
          }
        }
        lines.push(current);
        current = '';
        break;
      }
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  return lines.map(l => l.replace(/["\\]/g, ' ')).join('\\n');
}

export function effectiveWorkflowStatus(task, operations = []) {
  if (operations.some(op => op?.status === 'running' && op?.kind === 'task' && op?.target_id === task?.id)) return 'verifying';
  return STATUS_ORDER.includes(task?.status) ? task.status : 'backlog';
}

/**
 * Build the main ambient Status-Lane Pipeline workflow diagram.
 * Groups tasks by lifecycle status across all features with capped historical settled tasks.
 */
export function buildWorkflowDefinition(state = {}, theme = 'light') {
  const features = [...(state.features || [])];
  const tasks = [...(state.tasks || [])];
  const operations = state.operations || [];
  const palette = PALETTES[theme] || PALETTES.light;

  if (!features.length && !tasks.length) return { source: '', taskNodes: [], empty: true };
  if (!tasks.length) return { source: '', taskNodes: [], empty: true };

  const lines = ['flowchart LR'];
  for (const status of ['feature', 'endpoint', ...STATUS_ORDER]) {
    const [fill, stroke, textColor] = palette[status] || palette.ready;
    lines.push(`classDef ${status} fill:${fill},stroke:${stroke},color:${textColor || stroke},stroke-width:1.5px;`);
  }

  const tasksWithStatus = tasks.map(task => ({
    ...task,
    status: effectiveWorkflowStatus(task, operations)
  })).sort((a, b) => String(a.feature_id || '').localeCompare(String(b.feature_id || '')) || String(a.id).localeCompare(String(b.id)));

  const taskNodes = [];
  let taskIndex = 0;
  const activeLanes = [];

  for (const status of STATUS_ORDER) {
    const allTasksInStatus = tasksWithStatus.filter(t => t.status === status);
    if (!allTasksInStatus.length) continue;

    const laneId = `LANE_${status}`;
    activeLanes.push(laneId);
    lines.push(`subgraph ${laneId}["${LANE_TITLES[status]} (${allTasksInStatus.length})"]`);
    lines.push('direction TB');

    // In the main pipeline, cap settled display to the most recent 4 tasks to keep ambient HUD compact
    const tasksInStatus = (status === 'settled' && allTasksInStatus.length > 4)
      ? allTasksInStatus.slice(-4)
      : allTasksInStatus;

    for (let i = 0; i < tasksInStatus.length; i++) {
      const task = tasksInStatus[i];
      const nodeId = `T${taskIndex++}`;
      const featTag = task.feature_id ? ` [${task.feature_id}]` : '';
      const actorTag = task.assigned_actor ? ` · @${task.assigned_actor}` : '';
      const failTag = Number(task.consecutive_failures) > 0 ? ` ⚠️` : '';
      const label = `${task.id}${featTag}${actorTag}${failTag}`;
      const tooltip = `${task.id} · ${task.title || 'Untitled task'} · ${task.status.replace('_', ' ')} · ${task.assigned_actor || 'unassigned'} · ${Number(task.consecutive_failures) || 0} failure(s)`;
      lines.push(`${nodeId}("${label}")`);
      lines.push(`class ${nodeId} ${task.status};`);
      taskNodes.push({ nodeId, taskId: task.id, status: task.status, tooltip, featureId: task.feature_id });

      if (i > 0) {
        lines.push(`T${taskIndex - 2} ~~~ T${taskIndex - 1}`);
      }
    }

    if (status === 'settled' && allTasksInStatus.length > tasksInStatus.length) {
      const remainder = allTasksInStatus.length - tasksInStatus.length;
      const moreNodeId = `T${taskIndex++}`;
      lines.push(`${moreNodeId}("+ ${remainder} older settled")`);
      lines.push(`class ${moreNodeId} settled;`);
      if (tasksInStatus.length > 0) {
        lines.push(`T${taskIndex - 2} ~~~ ${moreNodeId}`);
      }
    }

    lines.push('end');
    const laneStyle = (SUBGRAPH_STYLES[theme] || SUBGRAPH_STYLES.light)[status];
    if (laneStyle) {
      lines.push(`style ${laneId} ${laneStyle}`);
    }
  }

  // Connect sequential non-blocked pipeline lanes
  const forwardLanes = activeLanes.filter(lane => lane !== 'LANE_blocked');
  for (let i = 0; i < forwardLanes.length - 1; i++) {
    lines.push(`${forwardLanes[i]} ==> ${forwardLanes[i + 1]}`);
  }
  // If blocked lane exists, show feedback connector from verifying or previous lane
  if (activeLanes.includes('LANE_blocked')) {
    if (activeLanes.includes('LANE_verifying')) {
      lines.push('LANE_verifying -.->|failed| LANE_blocked');
    } else if (forwardLanes.length > 0) {
      lines.push(`${forwardLanes[forwardLanes.length - 1]} -.-> LANE_blocked`);
    }
    if (activeLanes.includes('LANE_ready')) {
      lines.push('LANE_blocked -.->|re-queued| LANE_ready');
    }
  }

  return { source: lines.join('\n'), taskNodes, empty: taskNodes.length === 0 };
}

/**
 * Build a Feature Task Execution DAG for a specific feature contract.
 * Displays only child tasks belonging to the specified feature,
 * connected according to real after-TASK dependencies or execution sequence.
 */
export function buildFeatureKanbanDefinition(feature, tasks = [], operations = [], theme = 'light') {
  if (!feature || !feature.id) return { source: '', taskNodes: [], empty: true };
  const palette = PALETTES[theme] || PALETTES.light;
  const featureTasks = (tasks || [])
    .filter(t => t.feature_id === feature.id)
    .map(task => ({
      ...task,
      status: effectiveWorkflowStatus(task, operations)
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  if (!featureTasks.length) return { source: '', taskNodes: [], empty: true };

  const lines = ['flowchart LR'];
  for (const status of ['feature', 'endpoint', ...STATUS_ORDER]) {
    const [fill, stroke, textColor] = palette[status] || palette.ready;
    lines.push(`classDef ${status} fill:${fill},stroke:${stroke},color:${textColor || stroke},stroke-width:1.5px;`);
  }

  const safeFeatId = String(feature.id).replace(/[^a-zA-Z0-9_]/g, '_');
  const taskMap = new Map();
  const taskNodes = [];

  featureTasks.forEach((task, idx) => {
    const nodeId = `FT_${safeFeatId}_${idx}`;
    taskMap.set(task.id, { task, nodeId, idx });
  });

  const parsedDeps = new Map();
  let hasExplicitDeps = false;

  featureTasks.forEach(task => {
    const rawLabels = Array.isArray(task.labels) ? task.labels : (typeof task.labels === 'string' ? JSON.parse(task.labels || '[]') : []);
    const deps = rawLabels
      .filter(l => /^after-TASK-/.test(l))
      .map(l => l.slice('after-'.length))
      .filter(depId => taskMap.has(depId));
    if (deps.length > 0) hasExplicitDeps = true;
    parsedDeps.set(task.id, deps);
  });

  // Start node
  const startId = `START_${safeFeatId}`;
  lines.push(`${startId}([● Start]):::endpoint`);

  // Task nodes
  featureTasks.forEach((task, idx) => {
    const { nodeId } = taskMap.get(task.id);
    const shortTitle = wrapTitle(task.title || 'Untitled', 24, 2);
    const actorPart = task.assigned_actor ? ` (@${task.assigned_actor})` : '';
    const statusPart = STATUS_ICONS[task.status] || task.status;
    const label = `${task.id}\\n${shortTitle}\\n${statusPart}${actorPart}`;
    const tooltip = `${task.id} · ${task.title || 'Untitled task'} · ${task.status.replace('_', ' ')} · ${task.assigned_actor || 'unassigned'} · ${Number(task.consecutive_failures) || 0} failure(s)`;
    lines.push(`${nodeId}("${label}")`);
    lines.push(`class ${nodeId} ${task.status};`);
    taskNodes.push({ nodeId, taskId: task.id, status: task.status, tooltip });
  });

  // Settle node
  const settleId = `SETTLE_${safeFeatId}`;
  const isSettled = feature.status === 'settled' || featureTasks.every(t => t.status === 'settled');
  lines.push(`${settleId}([🏁 Settle${isSettled ? ' ✓' : ''}]):::${isSettled ? 'settled' : 'endpoint'}`);

  // Build DAG links
  if (hasExplicitDeps) {
    const dependentTaskIds = new Set();
    featureTasks.forEach(task => {
      const deps = parsedDeps.get(task.id) || [];
      const current = taskMap.get(task.id);
      if (deps.length === 0) {
        lines.push(`${startId} --> ${current.nodeId}`);
      } else {
        deps.forEach(depId => {
          const prereq = taskMap.get(depId);
          if (prereq) {
            lines.push(`${prereq.nodeId} --> ${current.nodeId}`);
            dependentTaskIds.add(depId);
          }
        });
      }
    });

    featureTasks.forEach(task => {
      if (!dependentTaskIds.has(task.id)) {
        const current = taskMap.get(task.id);
        lines.push(`${current.nodeId} --> ${settleId}`);
      }
    });
  } else {
    // Sequential execution chain if no explicit after-TASK labels
    if (featureTasks.length > 0) {
      lines.push(`${startId} --> ${taskMap.get(featureTasks[0].id).nodeId}`);
      for (let i = 0; i < featureTasks.length - 1; i++) {
        const from = taskMap.get(featureTasks[i].id).nodeId;
        const to = taskMap.get(featureTasks[i + 1].id).nodeId;
        lines.push(`${from} --> ${to}`);
      }
      lines.push(`${taskMap.get(featureTasks[featureTasks.length - 1].id).nodeId} --> ${settleId}`);
    }
  }

  return { source: lines.join('\n'), taskNodes, empty: false };
}

export const buildFeatureWorkflowDefinition = buildFeatureKanbanDefinition;

if (typeof window !== 'undefined') {
  window.VibeSyncWorkflow = {
    buildWorkflowDefinition,
    buildFeatureKanbanDefinition,
    buildFeatureWorkflowDefinition,
    effectiveWorkflowStatus
  };
}
