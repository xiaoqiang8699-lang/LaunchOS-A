export { GitError } from './errors';
export { GitService, isPlaceholderGitUrl } from './git.service';
export { parseGitRemote, assertSafeRemoteUrl } from './parse';
export type {
  CloneRepositoryOptions,
  DetectedRepository,
  GitAuthContext,
  GitCommitInfo,
  RemoteCommitInfo,
} from './types';
