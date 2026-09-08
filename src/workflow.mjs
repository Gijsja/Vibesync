/**
 * Build the client-side Mermaid definition for the live workflow HUD.
 * This deliberately represents only persisted feature-to-task membership;
 * VibeSync does not model dependencies between sibling tasks.
 */

const STATUS_ORDER = ['backlog', 'ready', 'in_progress', 'verifying', 'review', 'settled', 'blocked'];

const PALETTES = {
  light: {
    feature: ['#dbeafe', '#1d4ed8'], backlog: ['#e2e8f0', '#475569'], ready: ['#dbeafe', '#2563eb'],
    in_progress: ['#dcfce7', '#16a34a'], verifying: ['#f3e8ff', '#7e22ce'], review: ['#fef3c7', '#b45309'],
    settled: ['#dcfce7', '#15803d'], blocked: ['#fee2e2', '#dc2626']
  },
  dark: {
    feature: ['#172554', '#93c5fd'], backlog: ['#1e293b', '#94a3b8'], ready: ['#172554', '#60a5fa'],
    in_progress: ['#052e16', '#4ade80'], verifying: ['#3b0764', '#d8b4fe'], review: ['#451a03', '#fbbf24'],
    settled: ['#052e16', '#86efac'], blocked: ['#450a0a', '#fca5a5']
  }
};

function quoted(value) {
  return JSON.stringify(String(value ?? '').replace(/[\r\n]+/g, ' ').trim());
}

export function effectiveWorkflowStatus(task, operations = []) {
  if (operations.some(op => op?.status === 'running' && op?.kind === 'task' && op?.target_id === task?.id)) return 'verifying';
  return STATUS_ORDER.includes(task?.status) ? task.status : 'backlog';
}

export function buildWorkflowDefinition(state = {}, theme = 'light') {
  const features = [...(state.features || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const tasks = [...(state.tasks || [])];
  const operations = state.operations || [];
  const palette = PALETTES[theme] || PALETTES.light;

  if (!features.length) return { source: '', taskNodes: [], empty: true };

  const lines = ['flowchart TB'];
  for (const status of ['feature', ...STATUS_ORDER]) {
    const [fill, stroke] = palette[status];
    lines.push(`classDef ${status} fill:${fill},stroke:${stroke},color:${stroke},stroke-width:2px;`);
  }

  const taskNodes = [];
  let taskIndex = 0;
  features.forEach((feature, featureIndex) => {
    const featureNode = `F${featureIndex}`;
    lines.push(`subgraph GROUP${featureIndex}[${quoted(`${feature.id}: ${feature.title || 'Untitled feature'}`)}]`);
    lines.push('direction TB');
    lines.push(`${featureNode}[${quoted(`${feature.id}: ${feature.title || 'Untitled feature'}`)}]`);
    lines.push(`class ${featureNode} feature;`);
    const children = tasks.filter(task => task.feature_id === feature.id).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const task of children) {
      const nodeId = `T${taskIndex++}`;
      const status = effectiveWorkflowStatus(task, operations);
      const label = `${task.id}: ${task.title || 'Untitled task'} (${status.replace('_', ' ')})`;
      const tooltip = `${task.id} · ${status.replace('_', ' ')} · ${task.assigned_actor || 'unassigned'} · ${Number(task.consecutive_failures) || 0} failure(s)`;
      lines.push(`${nodeId}[${quoted(label)}]`);
      lines.push(`${featureNode} --> ${nodeId}`);
      lines.push(`class ${nodeId} ${status};`);
      taskNodes.push({ nodeId, taskId: task.id, tooltip, status });
    }
    if (!children.length) lines.push(`EMPTY${featureIndex}[${quoted('No tasks registered')}]`);
    lines.push('end');
  });
  return { source: lines.join('\n'), taskNodes, empty: false };
}

if (typeof window !== 'undefined') window.VibeSyncWorkflow = { buildWorkflowDefinition, effectiveWorkflowStatus };
