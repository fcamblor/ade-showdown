import { OrchestratorVersionSchema, type OrchestratorVersion } from '../../schema';
import { META } from './_meta';
import { LATEST_KNOWN_FEATURES } from './_latest-known-features';

const data: OrchestratorVersion = {
  ...META,
  version: '0.52.3',
  releaseDate: '2026-05-07',
  features: LATEST_KNOWN_FEATURES,
};

export default OrchestratorVersionSchema.parse(data);
