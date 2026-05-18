import { OrchestratorVersionSchema, type OrchestratorVersion } from '../../schema';
import { META } from './_meta';
import { LATEST_KNOWN_FEATURES } from './_latest-known-features';

const data: OrchestratorVersion = {
  ...META,
  version: '0.1.44',
  releaseDate: '2026-04-24',
  features: LATEST_KNOWN_FEATURES,
};

export default OrchestratorVersionSchema.parse(data);
