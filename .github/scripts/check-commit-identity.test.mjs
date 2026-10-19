import assert from 'node:assert/strict';
import test from 'node:test';
import { checkEvent, EMAIL, isOfficialMerge, validateCommit } from './check-commit-identity.mjs';

const sha = 'a'.repeat(40);
function normal() {
  return {
    sha, author: { login: 'keepraw' }, committer: { login: 'keepraw' },
    commit: {
      author: { name: 'keepraw', email: EMAIL },
      committer: { name: 'keepraw', email: EMAIL },
    },
    parents: [{ sha: 'b'.repeat(40) }],
  };
}
function merge() {
  const c = normal();
  c.committer = { login: 'web-flow', id: 19864447 };
  c.commit.committer = { name: 'GitHub', email: 'noreply@github.com' };
  c.commit.verification = { verified: true, reason: 'valid' };
  c.parents.push({ sha: 'c'.repeat(40) });
  return c;
}
test('exact Git identity and actual keepraw accounts pass', () => {
  assert.deepEqual(validateCommit(normal()), []);
});
for (const role of ['author', 'committer']) {
  test(`${role}: matching Git metadata cannot hide zzvw attribution`, () => {
    const c = normal(); c[role].login = 'zzvw';
    assert.ok(validateCommit(c).some(s => s.includes('zzvw is forbidden')));
  });
  test(`${role}: keepraw attribution cannot hide wrong name/email`, () => {
    const c = normal(); c.commit[role] = { name: 'Hongchuan Zhang', email: 'forgottenpedestrian@gmail.com' };
    assert.equal(validateCommit(c).length, 2);
  });
  test(`${role}: missing GitHub account fails closed`, () => {
    const c = normal(); c[role] = null;
    assert.ok(validateCommit(c).some(s => s.includes('GitHub login')));
  });
}
test('verified official GitHub merge retains web-flow committer', async () => {
  const c = merge();
  assert.equal(await isOfficialMerge(c, () => assert.fail('No PR lookup needed'), 'keepraw/keepraw-ledger'), true);
  assert.deepEqual(validateCommit(c, true), []);
  c.author.login = 'zzvw';
  assert.ok(validateCommit(c, true).length);
});
test('forged or unsigned web-flow committer is rejected', async () => {
  const c = merge(); c.commit.verification.verified = false;
  assert.equal(await isOfficialMerge(c, () => assert.fail('No lookup'), 'keepraw/keepraw-ledger'), false);
  assert.ok(validateCommit(c, true).length);
});
test('official squash merge requires a matching merged PR', async () => {
  const c = merge(); c.parents.pop();
  assert.equal(await isOfficialMerge(c, async () => [{ merged_at: '2026-10-19', merge_commit_sha: sha }], 'keepraw/keepraw-ledger'), true);
  assert.equal(await isOfficialMerge(c, async () => [{ merged_at: null, merge_commit_sha: sha }], 'keepraw/keepraw-ledger'), false);
  assert.equal(await isOfficialMerge(c, async () => [{ merged_at: '2026-10-19', merge_commit_sha: 'd'.repeat(40) }], 'keepraw/keepraw-ledger'), false);
});

const env = {
  GITHUB_REPOSITORY: 'keepraw/keepraw-ledger', GITHUB_EVENT_NAME: 'pull_request_target',
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '1',
};
function mock({ commits = [normal()], count = commits.length, changed = false, apiError = false } = {}) {
  const statuses = []; let reads = 0;
  const api = async (path, options) => {
    if (options?.method === 'POST') { statuses.push(options.body.state); return {}; }
    if (apiError) throw new Error('GitHub API unavailable');
    if (path.endsWith('/pulls/37')) {
      reads += 1;
      return { head: { sha: changed && reads > 1 ? 'd'.repeat(40) : sha }, commits: count };
    }
    const page = Number(new URL(`https://api.github.com/${path}`).searchParams.get('page'));
    return commits.slice((page - 1) * 100, page * 100);
  };
  return { api, statuses };
}
const event = { number: 37, pull_request: { head: { sha } } };
test('all PR pages are checked and success attaches to the real PR head', async () => {
  const commits = Array.from({ length: 101 }, (_, i) => ({ ...normal(), sha: i ? i.toString(16).padStart(40, '0') : sha }));
  const m = mock({ commits });
  assert.equal(await checkEvent(env, event, m.api), 101);
  assert.deepEqual(m.statuses, ['pending', 'success']);
});
test('a bad commit on a later page rejects the entire PR', async () => {
  const commits = Array.from({ length: 101 }, normal); commits[100].committer.login = 'zzvw';
  const m = mock({ commits });
  await assert.rejects(checkEvent(env, event, m.api), /zzvw is forbidden/);
  assert.deepEqual(m.statuses, ['pending', 'failure']);
});
test('truncated commit lists cannot pass', async () => {
  const m = mock({ count: 251 });
  await assert.rejects(checkEvent(env, event, m.api), /Incomplete PR commit list/);
  assert.deepEqual(m.statuses, ['pending', 'failure']);
});
test('a changed PR head cannot receive stale success', async () => {
  const m = mock({ changed: true });
  await assert.rejects(checkEvent(env, event, m.api), /PR head changed/);
  assert.deepEqual(m.statuses, ['pending', 'failure']);
});
test('GitHub API failure cannot approve a PR', async () => {
  const m = mock({ apiError: true });
  await assert.rejects(checkEvent(env, event, m.api), /GitHub API unavailable/);
  assert.deepEqual(m.statuses, ['failure']);
});
