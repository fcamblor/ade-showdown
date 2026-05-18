import { OrchestratorVersionSchema, type OrchestratorVersion } from '../../schema';
import { META } from './_meta';
import { LATEST_KNOWN_FEATURES } from './_latest-known-features';

const data: OrchestratorVersion = {
  ...META,
  status: 'waiting-for-review',
  version: '1.6608.3',
  releaseDate: '2026-05-17',
  versionDetails: {
    buildHash: 'ebf1a1',
    buildDate: '2026-05-17T23:17:27.000Z',
  },
  features: LATEST_KNOWN_FEATURES,
};

export default OrchestratorVersionSchema.parse(data);
