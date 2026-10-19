import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const NAME = 'keepraw';
export const EMAIL = '49091395+keepraw@users.noreply.github.com';
export const STATUS = 'Commit identity';

function signedByGitHub(commit) {
  return commit.committer?.login === 'web-flow'
    && commit.committer?.id === 19864447
    && commit.commit?.committer?.name === 'GitHub'
    && commit.commit?.committer?.email === 'noreply@github.com'
    && commit.commit?.verification?.verified === true
    && commit.commit?.verification?.reason === 'valid';
}

export function validateCommit(commit, officialMerge = false) {
  const errors = [];
  for (const role of ['author', 'committer']) {
    if (commit[role]?.login === 'zzvw') errors.push(`${role}: zzvw is forbidden`);
    if (role === 'committer' && officialMerge && signedByGitHub(commit)) continue;
    if (commit.commit?.[role]?.name !== NAME) errors.push(`${role}: name must be ${NAME}`);
    if (commit.commit?.[role]?.email !== EMAIL) errors.push(`${role}: email must be ${EMAIL}`);
    if (commit[role]?.login !== NAME) errors.push(`${role}: GitHub login must be ${NAME}`);
  }
  return errors;
}

export async function isOfficialMerge(commit, api, repository) {
  if (!signedByGitHub(commit)) return false;
  if (commit.parents?.length > 1) return true;
  // Squash/rebase merges have one parent. Require an actual merged PR as well
  // as GitHub's verified signature; a forged noreply address is insufficient.
  for (let page = 1; ; page += 1) {
    const pulls = await api(`repos/${repository}/commits/${commit.sha}/pulls?per_page=100&page=${page}`);
    if (pulls.some(pr => pr.merged_at && pr.merge_commit_sha === commit.sha)) return true;
    if (pulls.length < 100) return false;
  }
}

export async function checkEvent(env, event, api) {
  const repository = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  const isPull = env.GITHUB_EVENT_NAME === 'pull_request_target';
  if (!isPull && !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('Unsupported identity-check event');
  }
  const number = event.pull_request?.number ?? event.number;
  if (isPull && !Number.isSafeInteger(number)) throw new Error('Missing pull request number');
  let sha = isPull ? event.pull_request?.head?.sha : env.GITHUB_SHA;
  const publish = async (state, description) => {
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('Invalid commit SHA');
    await api(`repos/${repository}/statuses/${sha}`, {
      method: 'POST',
      body: {
        state, context: STATUS, description,
        target_url: `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
      },
    });
  };
  try {
    let commits;
    if (isPull) {
      const pull = await api(`repos/${repository}/pulls/${number}`);
      sha = pull.head.sha;
      await publish('pending', 'Checking every PR commit and GitHub account attribution');
      commits = [];
      for (let page = 1; ; page += 1) {
        const batch = await api(`repos/${repository}/pulls/${number}/commits?per_page=100&page=${page}`);
        commits.push(...batch);
        if (batch.length < 100) break;
      }
      // GitHub's PR commits endpoint is capped at 250. Never silently approve
      // an incomplete response (including a PR changed during pagination).
      if (!commits.length || commits.length !== pull.commits || !commits.some(c => c.sha === sha)) {
        throw new Error('Incomplete PR commit list; split PRs over 250 commits and retry');
      }
    } else {
      await publish('pending', 'Checking main commit Git metadata and GitHub attribution');
      commits = [await api(`repos/${repository}/commits/${sha}`)];
    }
    const errors = [];
    for (const commit of commits) {
      const official = await isOfficialMerge(commit, api, repository);
      const violations = validateCommit(commit, official);
      if (violations.length) errors.push(`${commit.sha}: ${violations.join('; ')}`);
      else console.log(`${commit.sha}: keepraw author / ${official ? 'official GitHub merge' : 'keepraw committer'}`);
    }
    if (isPull) {
      const latest = await api(`repos/${repository}/pulls/${number}`);
      if (latest.head.sha !== sha) throw new Error('PR head changed during validation; retry on the latest head');
    }
    if (errors.length) throw new Error(errors.join('\n'));
    await publish('success', `${commits.length} commit(s): Git metadata and GitHub accounts verified`);
    return commits.length;
  } catch (error) {
    await publish('failure', 'Commit identity rejected or GitHub attribution could not be verified');
    throw error;
  }
}

export function githubApi(env) {
  if (!env.GH_TOKEN) throw new Error('Missing GitHub token');
  const origin = `${env.GITHUB_API_URL ?? 'https://api.github.com'}/`;
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(new URL(path, origin), {
      method,
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    await checkEvent(process.env, event, githubApi(process.env));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
