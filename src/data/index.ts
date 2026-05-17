import type { OrchestratorVersion } from './schema';

const modules = import.meta.glob<{ default: OrchestratorVersion }>(
  './orchestrators/*/*.ts',
  { eager: true },
);

const ALL_VERSIONS: OrchestratorVersion[] = Object.values(modules).map((m) => m.default);

// Newest-first comparator. Prefers ISO releaseDate; falls back to numeric-aware
// version string comparison so e.g. "0.52.3" sorts above "0.5.0".
function compareNewestFirst(a: OrchestratorVersion, b: OrchestratorVersion): number {
  if (a.releaseDate && b.releaseDate) {
    return b.releaseDate.localeCompare(a.releaseDate);
  }
  if (a.releaseDate) return -1;
  if (b.releaseDate) return 1;
  return b.version.localeCompare(a.version, undefined, { numeric: true });
}

export const ORCHESTRATORS_BY_TOOL: Record<string, OrchestratorVersion[]> = {};
for (const v of ALL_VERSIONS) {
  (ORCHESTRATORS_BY_TOOL[v.toolId] ??= []).push(v);
}
for (const toolId of Object.keys(ORCHESTRATORS_BY_TOOL)) {
  ORCHESTRATORS_BY_TOOL[toolId].sort(compareNewestFirst);
}

export function isApproved(v: OrchestratorVersion): boolean {
  return (v.status ?? 'approved') === 'approved';
}

// Public table: latest approved version per tool, plus every waiting-for-review
// version (rendered but hidden by default — revealed by the preview query
// param). For each tool, the approved column comes first, followed by any
// pending columns in newest-first order. Tools that only have pending versions
// still produce columns so the preview link can surface them.
export const ORCHESTRATORS: OrchestratorVersion[] = (() => {
  const toolIds = Object.keys(ORCHESTRATORS_BY_TOOL).sort((a, b) => {
    const an = ORCHESTRATORS_BY_TOOL[a][0].toolName;
    const bn = ORCHESTRATORS_BY_TOOL[b][0].toolName;
    return an.localeCompare(bn);
  });
  const out: OrchestratorVersion[] = [];
  for (const id of toolIds) {
    const versions = ORCHESTRATORS_BY_TOOL[id];
    const approved = versions.find(isApproved);
    if (approved) out.push(approved);
    for (const v of versions) {
      if (!isApproved(v)) out.push(v);
    }
  }
  return out;
})();

export { FEATURES } from './features';
