import { describe, it, expect } from 'vitest';
import { parseGitHubRemoteUrl } from '../github-service';

describe('parseGitHubRemoteUrl', () => {
  it('parses HTTPS URLs', () => {
    const result = parseGitHubRemoteUrl('https://github.com/owner/repo.git');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  it('parses HTTPS URLs without .git suffix', () => {
    const result = parseGitHubRemoteUrl('https://github.com/owner/repo');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  it('parses SSH URLs', () => {
    const result = parseGitHubRemoteUrl('git@github.com:owner/repo.git');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  it('parses SSH URLs without .git suffix', () => {
    const result = parseGitHubRemoteUrl('git@github.com:owner/repo');
    expect(result).toEqual({
      owner: 'owner',
      repo: 'repo',
      fullName: 'owner/repo',
    });
  });

  it('returns null for GitLab URLs', () => {
    expect(parseGitHubRemoteUrl('https://gitlab.com/owner/repo.git')).toBeNull();
  });

  it('returns null for Bitbucket URLs', () => {
    expect(parseGitHubRemoteUrl('git@bitbucket.org:owner/repo.git')).toBeNull();
  });

  it('returns null for non-git URLs', () => {
    expect(parseGitHubRemoteUrl('https://example.com')).toBeNull();
  });

  it('handles repos with hyphens and dots', () => {
    const result = parseGitHubRemoteUrl('https://github.com/my-org/my.project.git');
    expect(result).toEqual({
      owner: 'my-org',
      repo: 'my.project',
      fullName: 'my-org/my.project',
    });
  });

  it('handles repos with underscores', () => {
    const result = parseGitHubRemoteUrl('git@github.com:some_user/some_repo.git');
    expect(result).toEqual({
      owner: 'some_user',
      repo: 'some_repo',
      fullName: 'some_user/some_repo',
    });
  });
});
