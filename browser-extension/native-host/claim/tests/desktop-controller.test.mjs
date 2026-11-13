import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  DesktopController,
  FileExecutionJournal,
  verifyGitHubWebhookSignature,
} from '../dist/native-host/claim/desktop-controller.js';

const REPO = 'jan2xo/bke-worker';
const WORKER = 'worker-f1';
const PR = 129;
const HEAD = 'a'.repeat(40);

test('verifyGitHubWebhookSignature accepts exact HMAC-SHA256 and rejects tampered/missing/malformed headers', () => {
  const secret = 'controller-secret-123';
  const body = JSON.stringify({action: 'completed', pr: 129});
  const valid = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(verifyGitHubWebhookSignature({secret, signatureHeader: valid, rawBody: body}), true);
  assert.equal(verifyGitHubWebhookSignature({secret, signatureHeader: 'sha256=' + '0'.repeat(64), rawBody: body}), false);
  assert.equal(verifyGitHubWebhookSignature({secret, signatureHeader: 'sha1=abc', rawBody: body}), false);
  assert.equal(verifyGitHubWebhookSignature({secret, signatureHeader: undefined, rawBody: body}), false);
  assert.equal(verifyGitHubWebhookSignature({secret: '', signatureHeader: valid, rawBody: body}), false);
});

test('FileExecutionJournal enforces 0o600 permissions, deduplicates deliveries, and quarantines DISPATCHING/CONTINUING crashes on recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bke-journal-test-'));
  const journalPath = join(dir, 'journal.json');
  try {
    const j1 = new FileExecutionJournal(journalPath, {repository: REPO, prNumber: PR, workerId: WORKER});
    const init = await j1.openAndRecover();
    assert.equal(init.phase, 'IDLE');
    const st = await stat(journalPath);
    assert.equal(st.mode & 0o077, 0);

    assert.equal(await j1.recordDelivery('deliv-1'), true);
    assert.equal(await j1.recordDelivery('deliv-1'), false);

    // Simulate crash during CONTINUING
    await j1.transition({phase: 'CONTINUING', activeAttemptId: 'attempt-2', conversationId: 'conv-01', confirmedTurnCount: 1});
    const j2 = new FileExecutionJournal(journalPath, {repository: REPO, prNumber: PR, workerId: WORKER});
    const recovered = await j2.openAndRecover();
    assert.equal(recovered.phase, 'DELIVERY_UNCERTAIN');
    assert.equal(recovered.uncertainReason, 'CRASH_DURING_CONTINUING');

    // Mismatched journal identity fails closed
    const bad = new FileExecutionJournal(journalPath, {repository: REPO, prNumber: PR + 1, workerId: WORKER});
    await assert.rejects(() => bad.openAndRecover(), /JOURNAL_IDENTITY_MISMATCH/);

    // Explicit halt stops future wakes
    const j3Path = join(dir, 'journal-halt.json');
    const j3 = new FileExecutionJournal(j3Path, {repository: REPO, prNumber: PR, workerId: WORKER});
    const ctrl = new DesktopController({
      journal: j3,
      createLedger: () => { throw Error('UNREACHABLE'); },
      createBrowserPorts: () => { throw Error('UNREACHABLE'); },
      liveProofs: {
        githubCasOwnerCertified: true,
        nativePairingOwnerCertified: true,
        realBrowserOwnerAccepted: true,
      },
    });
    await ctrl.initialize();
    await ctrl.halt('EMERGENCY_STOP');
    const wakeAfterHalt = await ctrl.processAuthorizedWake({
      headSha: HEAD,
      prNumber: PR,
      humanLiveSendAuthorized: true,
    });
    assert.equal(wakeAfterHalt.code, 'CONTROLLER_HALTED');
    const disk = JSON.parse(await readFile(j3Path, 'utf8'));
    assert.equal(disk.phase, 'HALTED');
    void writeFile;
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
