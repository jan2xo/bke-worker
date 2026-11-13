import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHubF1Ledger} from '../dist/native-host/claim/github-f1-ledger.js';

const HEAD = 'a'.repeat(40);
const TREE = 'e'.repeat(40);
const TOKEN = 'secret-installation-token';
const REPO = 'jan2xo/bke-worker';
const PINNED_APP = {id: 9001, slug: 'bke-dispatcher-app'};

function createStatefulGitHubServer({
  openPrs = [{number: 123, state: 'open', head: {sha: HEAD}, labels: [{name: 'bke-worker:worker-f1'}]}],
  checkRuns = [],
  existingRefs = {},
  commits = {},
  repoPush = true,
  failOn = null,
} = {}) {
  const refs = new Map(Object.entries(existingRefs));
  const commitStore = new Map(Object.entries({
    [HEAD]: {sha: HEAD, tree: {sha: TREE}, parents: [], message: 'pr head'},
    ...commits,
  }));
  const requests = [];
  let seq = 1;

  const res = (status, body, headers = {}) => ({
    status,
    headers: {get: (name) => headers[name.toLowerCase()] ?? null},
    json: async () => body,
  });

  const fetch = async (url, init) => {
    requests.push({method: init.method, url, body: init.body ? JSON.parse(init.body) : null});
    const parsed = new URL(url);
    const p = parsed.pathname;

    if (failOn && failOn(init.method, p, parsed)) {
      throw new Error(`network failure ${TOKEN}`);
    }

    if (init.method === 'GET' && p === '/installation/repositories') {
      return res(200, {
        repositories: [{full_name: REPO, permissions: {push: repoPush}}],
      });
    }
    if (init.method === 'GET' && p === `/repos/${REPO}/pulls`) {
      return res(200, openPrs);
    }
    if (init.method === 'GET' && p.startsWith(`/repos/${REPO}/pulls/`)) {
      const prNum = Number(p.split('/').pop());
      const pr = openPrs.find((x) => x.number === prNum);
      return pr ? res(200, pr) : res(404, {message: 'Not Found'});
    }
    if (init.method === 'GET' && p === `/repos/${REPO}/git/matching-refs/bke/`) {
      const list = [...refs.entries()]
        .filter(([k]) => k.startsWith('refs/bke/'))
        .map(([ref, sha]) => ({ref, object: {sha}}));
      return res(200, list);
    }
    if (init.method === 'GET' && p === `/repos/${REPO}/commits/${HEAD}/check-runs`) {
      return res(200, {total_count: checkRuns.length, check_runs: checkRuns});
    }
    if (init.method === 'GET' && p.startsWith(`/repos/${REPO}/git/commits/`)) {
      const sha = p.split('/').pop();
      const c = commitStore.get(sha);
      return c ? res(200, c) : res(404, {message: 'Not Found'});
    }
    if (init.method === 'POST' && p === `/repos/${REPO}/git/commits`) {
      const body = JSON.parse(init.body);
      const sha = (String(seq++).padStart(40, '0')).slice(-40);
      const created = {sha, tree: {sha: body.tree}, parents: body.parents, message: body.message};
      commitStore.set(sha, created);
      return res(201, created);
    }
    if (init.method === 'GET' && p.startsWith(`/repos/${REPO}/git/ref/`)) {
      const ref = 'refs/' + p.slice(`/repos/${REPO}/git/ref/`.length);
      const sha = refs.get(ref);
      return sha ? res(200, {ref, object: {sha}}) : res(404, {message: 'Not Found'});
    }
    if (init.method === 'POST' && p === `/repos/${REPO}/git/refs`) {
      const body = JSON.parse(init.body);
      if (refs.has(body.ref)) {
        return res(422, {message: 'Reference already exists'});
      }
      refs.set(body.ref, body.sha);
      return res(201, {ref: body.ref, object: {sha: body.sha}});
    }
    if (init.method === 'PATCH' && p.startsWith(`/repos/${REPO}/git/refs/`)) {
      const ref = 'refs/' + p.slice(`/repos/${REPO}/git/refs/`.length);
      const body = JSON.parse(init.body);
      if (!refs.has(ref)) return res(422, {message: 'Reference does not exist'});
      refs.set(ref, body.sha);
      return res(200, {ref, object: {sha: body.sha}});
    }
    return res(404, {message: 'Unhandled'});
  };

  return {fetch, refs, commitStore, requests};
}

function validTicket(attemptId = 'attempt-1', overrides = {}) {
  const exp = Math.floor(Date.parse('2026-10-20T12:00:00.000Z') / 1000);
  return {
    id: 501,
    name: 'bke-ticket',
    app: PINNED_APP,
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'success',
    external_id: `bke-ticket:v1:worker-f1:${attemptId}:${exp}`,
    ...overrides,
  };
}

function makeLedger(server, overrides = {}) {
  let tick = 0;
  const times = [
    '2026-10-20T09:00:00.000Z',
    '2026-10-20T09:00:01.000Z',
    '2026-10-20T09:00:02.000Z',
    '2026-10-20T09:00:03.000Z',
    '2026-10-20T09:00:04.000Z',
    '2026-10-20T09:00:05.000Z',
  ];
  return new GitHubF1Ledger(
    {
      repository: REPO,
      prNumber: 123,
      headSha: HEAD,
      workerId: 'worker-f1',
      authenticatedWorkerId: 'worker-f1',
      pinnedApp: PINNED_APP,
      executionId: 'exec-1',
      targetId: 'target-01',
      profileId: 'profile-01',
      targetTabId: 7,
      nowIso: () => times[Math.min(tick++, times.length - 1)],
      ...overrides,
    },
    server.fetch,
    async () => TOKEN,
  );
}

test('F1-02 ledger refreshes authority, enforces pinned App + 1:1 PR, commits fence/claim/receipt and reads back', async () => {
  const server = createStatefulGitHubServer({checkRuns: [validTicket('attempt-1')]});
  const ledger = makeLedger(server);
  const auth = await ledger.refreshAuthority();
  assert.equal(auth.activeWorkerPrCount, 1);
  assert.equal(auth.ticket.attemptId, 'attempt-1');

  const fence = {
    durable: true,
    fenceId: 'fence-attempt-1',
    commitSha: HEAD,
    attemptId: 'attempt-1',
    workerId: 'worker-f1',
    headSha: HEAD,
    targetId: 'target-01',
    profileId: 'profile-01',
    targetTabId: 7,
    executionId: 'exec-1',
    generation: 1,
    committedAt: '2026-10-20T09:00:01.000Z',
  };
  const fw = await ledger.commitPreSendFence(fence);
  assert.equal(fw.status, 'COMMITTED');
  assert.equal(await ledger.readBackPreSendFence(fw.commitSha), true);

  const claim = {
    durable: true,
    claimId: 'claim-attempt-1',
    commitSha: HEAD,
    fenceId: fence.fenceId,
    fenceCommitSha: fw.commitSha,
    attemptId: 'attempt-1',
    workerId: 'worker-f1',
    headSha: HEAD,
    targetId: 'target-01',
    profileId: 'profile-01',
    targetTabId: 7,
    executionId: 'exec-1',
    generation: 1,
    claimedAt: '2026-10-20T09:00:02.000Z',
  };
  const cw = await ledger.consumeFirstSendClaim(claim);
  assert.equal(cw.status, 'COMMITTED');
  assert.equal(cw.commitSha, HEAD);
  assert.equal(server.refs.get('refs/bke/claims/123/attempt-1'), HEAD);
  assert.equal(await ledger.readBackFirstSendClaim(HEAD), true);

  // Duplicate claim is blocked locally & server would 422 anyway
  assert.equal((await ledger.consumeFirstSendClaim(claim)).status, 'CONFLICT');

  const rec = await ledger.reconcileConversation({
    event: 'FIRST_MESSAGE_CREATED_CONVERSATION',
    attemptId: 'attempt-1',
    workerId: 'worker-f1',
    headSha: HEAD,
    fenceId: fence.fenceId,
    fenceCommitSha: fw.commitSha,
    sendClaimId: claim.claimId,
    sendClaimCommitSha: HEAD,
    targetId: 'target-01',
    profileId: 'profile-01',
    targetTabId: 7,
    beforeUrl: 'https://chatgpt.com/',
    afterUrl: 'https://chatgpt.com/c/conv-live-0001',
    conversationId: 'conv-live-0001',
    sendStartedAt: '2026-10-20T09:00:03.000Z',
    confirmedAt: '2026-10-20T09:00:04.000Z',
  });
  assert.equal(rec.ok, true);
  assert.equal(await ledger.readBackConversation('conv-live-0001'), true);
});

test('F1-02 rejects worker on 2 open PRs, github-actions forged check run, consumed attempt, and uncertain marker', async () => {
  const multiPr = createStatefulGitHubServer({
    openPrs: [
      {number: 123, state: 'open', head: {sha: HEAD}, labels: [{name: 'bke-worker:worker-f1'}]},
      {number: 124, state: 'open', head: {sha: HEAD}, labels: [{name: 'bke-worker:worker-f1'}]},
    ],
    checkRuns: [validTicket('attempt-1')],
  });
  await assert.rejects(() => makeLedger(multiPr).refreshAuthority(), /GITHUB_WORKER_MULTI_PR_CONFLICT/);

  const wrongApp = createStatefulGitHubServer({
    checkRuns: [validTicket('attempt-1', {app: {id: 1, slug: 'github-actions'}})],
  });
  await assert.rejects(() => makeLedger(wrongApp).refreshAuthority(), /GITHUB_TICKET_INVALID_OR_CONSUMED/);

  const alreadyClaimed = createStatefulGitHubServer({
    checkRuns: [validTicket('attempt-1')],
    existingRefs: {'refs/bke/claims/123/attempt-1': HEAD},
  });
  await assert.rejects(() => makeLedger(alreadyClaimed).refreshAuthority(), /GITHUB_TICKET_INVALID_OR_CONSUMED/);

  const uncertainPr = createStatefulGitHubServer({
    checkRuns: [validTicket('attempt-2')],
    existingRefs: {'refs/bke/uncertain/123/attempt-1': HEAD},
  });
  await assert.rejects(() => makeLedger(uncertainPr).refreshAuthority(), /GITHUB_DELIVERY_UNCERTAIN_QUARANTINED/);
});

test('F1-02 claim POST transport uncertainty does not retry and quarantines', async () => {
  // Fail on claims POST specifically (2nd POST to /git/refs)
  const server2 = createStatefulGitHubServer({
    checkRuns: [validTicket('attempt-1')],
    failOn: (method, path) =>
      method === 'POST' &&
      path.endsWith('/git/refs') &&
      server2.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/git/refs')).length >= 2,
  });
  const ledger2 = makeLedger(server2);
  await ledger2.refreshAuthority();
  const fw2 = await ledger2.commitPreSendFence({
    durable: true, fenceId: 'fence-attempt-1', commitSha: HEAD, attemptId: 'attempt-1',
    workerId: 'worker-f1', headSha: HEAD, targetId: 'target-01', profileId: 'profile-01',
    targetTabId: 7, executionId: 'exec-1', generation: 1, committedAt: '2026-10-20T09:00:01.000Z',
  });
  assert.equal(fw2.status, 'COMMITTED');
  assert.equal(await ledger2.readBackPreSendFence(fw2.commitSha), true);
  const cw2 = await ledger2.consumeFirstSendClaim({
    durable: true, claimId: 'claim-attempt-1', commitSha: HEAD, fenceId: 'fence-attempt-1',
    fenceCommitSha: fw2.commitSha, attemptId: 'attempt-1', workerId: 'worker-f1',
    headSha: HEAD, targetId: 'target-01', profileId: 'profile-01',
    targetTabId: 7, executionId: 'exec-1', generation: 1, claimedAt: '2026-10-20T09:00:02.000Z',
  });
  assert.equal(cw2.status, 'UNCERTAIN');
  assert.equal(server2.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/git/refs')).length, 2);
});
