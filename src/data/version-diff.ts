import type { FeatureSupport, OrchestratorVersion } from './schema';

// Tool-level metadata: every field of an OrchestratorVersion that does not
// change across versions of the same tool. A `meta.ts` per orchestrator
// exports a value of this type; each version file spreads it in and adds the
// remaining version-specific fields (version, releaseDate, …).
export type OrchestratorMeta = Omit<
  OrchestratorVersion,
  'version' | 'releaseDate' | 'versionDetails' | 'status' | 'features'
>;

// A single edit to apply on top of a baseline feature array. The three
// variants cover the only operations needed when describing an older version
// as a diff against the latest:
//   - `remove`:   the feature did not exist yet (or has been retired).
//   - `override`: the feature existed but with a different support level / note.
//   - `add`:      the feature existed only in this version (rare — typically
//                 used when a feature was later removed from the product).
export type FeatureDiff =
  | { remove: string }
  | { override: string; with: Partial<Omit<FeatureSupport, 'featureId'>> }
  | { add: FeatureSupport };

// Apply an ordered list of diffs to a baseline (usually the latest version's
// feature array) to produce the feature array for an older version. Throws
// loudly on stale refs so a featureId rename in the baseline doesn't silently
// drop edits in older versions.
export function deriveVersionFeatures(
  baseline: readonly FeatureSupport[],
  diffs: readonly FeatureDiff[],
): FeatureSupport[] {
  const result: FeatureSupport[] = baseline.map((f) => ({ ...f }));
  for (const d of diffs) {
    if ('remove' in d) {
      const idx = result.findIndex((f) => f.featureId === d.remove);
      if (idx < 0) {
        throw new Error(`deriveVersionFeatures: cannot remove unknown feature "${d.remove}"`);
      }
      result.splice(idx, 1);
    } else if ('add' in d) {
      if (result.some((f) => f.featureId === d.add.featureId)) {
        throw new Error(
          `deriveVersionFeatures: cannot add "${d.add.featureId}", already exists in baseline`,
        );
      }
      result.push(d.add);
    } else {
      const idx = result.findIndex((f) => f.featureId === d.override);
      if (idx < 0) {
        throw new Error(
          `deriveVersionFeatures: cannot override unknown feature "${d.override}"`,
        );
      }
      result[idx] = { ...result[idx], ...d.with };
    }
  }
  return result;
}
