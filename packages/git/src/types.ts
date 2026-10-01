export type GitAuthContext = {
  /** Short-lived token. Never log this value. */
  token: string;
  /** Git username for HTTPS auth. GitHub App uses x-access-token. */
  username?: string;
};

export type CloneRepositoryOptions = {
  url: string;
  directory: string;
  branch?: string;
  auth?: GitAuthContext;
};

export type DetectedRepository = {
  url: string;
  owner: string | null;
  name: string;
  defaultBranch: string | null;
  reachable: boolean;
  errorMessage?: string | null;
};

export type GitCommitInfo = {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
};

export type RemoteCommitInfo = {
  sha: string;
  shortSha: string;
  message: string;
};
