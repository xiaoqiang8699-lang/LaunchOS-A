import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LOCAL_GITHUB_CALLBACK_URL,
  PUBLIC_GITHUB_CALLBACK_URL,
  classifyCallbackUrl,
  evaluateGitHubConnectionCapability,
  githubAppPublicSettingsUrls,
  requiresPublicGithubCallback,
  resolveGithubCallbackUrl,
} from './callback-readiness.js';

describe('github callback readiness', () => {
  it('keeps local development on the web bridge localhost callback', () => {
    assert.equal(requiresPublicGithubCallback({ NODE_ENV: 'development' }), false);
    assert.equal(
      resolveGithubCallbackUrl({ NODE_ENV: 'development' }),
      LOCAL_GITHUB_CALLBACK_URL,
    );
    assert.equal(
      resolveGithubCallbackUrl({
        NODE_ENV: 'development',
        GITHUB_APP_CALLBACK_URL: 'http://localhost:3000/git/github/callback',
      }),
      'http://localhost:3000/git/github/callback',
    );
  });

  it('never falls back to localhost in production or external alpha', () => {
    assert.equal(requiresPublicGithubCallback({ NODE_ENV: 'production' }), true);
    assert.equal(requiresPublicGithubCallback({ LAUNCHOS_ENV: 'alpha' }), true);
    assert.equal(resolveGithubCallbackUrl({ NODE_ENV: 'production' }), null);
    assert.equal(
      resolveGithubCallbackUrl({
        NODE_ENV: 'production',
        GITHUB_APP_CALLBACK_URL: PUBLIC_GITHUB_CALLBACK_URL,
      }),
      PUBLIC_GITHUB_CALLBACK_URL,
    );
  });

  it('marks localhost callback as NOT_READY for external alpha', () => {
    const result = evaluateGitHubConnectionCapability({
      env: { NODE_ENV: 'production', LAUNCHOS_ENV: 'alpha' },
      configured: true,
      callbackUrl: 'http://localhost:3000/git/github/callback',
      webOrigin: 'http://localhost:3000',
    });
    assert.equal(result.status, 'NOT_READY');
    assert.equal(result.diagnosis, 'GitHub 回调地址不是公网 HTTPS 地址');
    assert.equal(result.reason, 'CALLBACK_NOT_PUBLIC');
  });

  it('is READY when public HTTPS web callback and WEB_ORIGIN are set', () => {
    const result = evaluateGitHubConnectionCapability({
      env: { NODE_ENV: 'production', LAUNCHOS_ENV: 'alpha' },
      configured: true,
      callbackUrl: PUBLIC_GITHUB_CALLBACK_URL,
      webOrigin: 'https://alpha.zsaos.com',
    });
    assert.equal(result.status, 'READY');
    assert.equal(result.diagnosis, null);
    assert.equal(result.callbackHostKind, 'public_https');
  });

  it('marks missing production callback as NOT_READY with public diagnosis', () => {
    const result = evaluateGitHubConnectionCapability({
      env: { NODE_ENV: 'production', LAUNCHOS_ENV: 'alpha' },
      configured: true,
      callbackUrl: null,
      webOrigin: 'https://alpha.zsaos.com',
    });
    assert.equal(result.status, 'NOT_READY');
    assert.equal(result.diagnosis, 'GitHub 回调地址不是公网 HTTPS 地址');
    assert.equal(result.reason, 'CALLBACK_MISSING');
  });

  it('classifies hosts and publishes exact GitHub App settings', () => {
    assert.equal(classifyCallbackUrl('https://alpha.zsaos.com/git/github/callback').kind, 'public_https');
    assert.equal(classifyCallbackUrl('http://127.0.0.1:3000/git/github/callback').kind, 'localhost');
    assert.equal(classifyCallbackUrl('http://10.0.0.8/callback').kind, 'localhost');
    const settings = githubAppPublicSettingsUrls();
    assert.equal(settings.callbackUrl, PUBLIC_GITHUB_CALLBACK_URL);
    assert.equal(settings.setupUrl, PUBLIC_GITHUB_CALLBACK_URL);
    assert.equal(settings.homepageUrl, 'https://alpha.zsaos.com');
    assert.equal(settings.permissions.contents, 'read');
    assert.equal(settings.permissions.metadata, 'read');
    assert.equal(settings.webhookUrl, null);
  });
});
