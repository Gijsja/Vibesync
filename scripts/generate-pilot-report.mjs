export function generatePilotReport({ baseline = null, comparison = null } = {}) {
  const measured = baseline && comparison;
  return `# Efficiency pilot results\n\n## Evidence status\n\n${measured ? 'A matched baseline and comparison were supplied.' : 'No matched before/after provider run is available; no savings or quality claim is made.'}\n\n## Recorded deterministic evidence\n\n- Lifecycle baseline covers settlement, repair, scope rejection, lease expiry, and handoff.\n- Task gates were recorded by VibeSync; provider token and cost fields remain unknown unless provider evidence exists.\n- MCP response semantics were preserved; compression was deferred pending matched behavioral evidence.\n\n## Follow-up\n\nRun identical scenarios with recorded provider/model/revision metadata before claiming a before/after result.\n`;
}

if (import.meta.main) process.stdout.write(generatePilotReport());
