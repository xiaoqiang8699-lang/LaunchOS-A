export type AuthUser = {
  id: string;
  email: string;
  name: string;
  sessionId?: string;
};

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  hasCompletedOnboarding: boolean;
  onboardingStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
  isInternal: boolean;
  platformRole: 'USER' | 'PLATFORM_ADMIN';
  isFirstTimeUser: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicWorkspace = {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
};
