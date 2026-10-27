/** F1-02 GitHub REST transport. Server-private only; never put a token in a browser. */
import type {ClaimAuthority, SendOnceAttempt, SendOnceGitHub} from '../browser-extension/src/send-once-claim.js';

export interface HttpResponse {
  status: number;
  json(): Promise<unknown>;
}
export type HttpFetch = (url: string, init: RequestInit & {signal: AbortSignal}) => Promise<HttpResponse>;
export type TokenProvider = () => string | Promise<string>;

/** TODO: supply from independently authenticated installation and ownership reader.
 * A PR GET cannot prove any of these fields. Missing inputs always block.
 */
export interface ExplicitAuthorityInputs {
  installationRepository?: string;
  installationAuthenticated?: boolean;
  authenticatedWorkerId?: string;
  activeWorkerPrCount?: number;
  currentAttemptId?: string;
}
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ATTEMPT = /^[a-z0-9][a-z0-9-]{0,95}$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('GITHUB_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !SHA.test(value))
    throw Error('GITHUB_SHA_INVALID');
  return value;
}
function cleanLabel(value: unknown): string {
  const label = record(value);
  if (typeof label.name !== 'string') throw Error('GITHUB_LABEL_INVALID');
  return label.name;
}

export class GitHubSendOnceRestAdapter implements SendOnceGitHub {
  private accessProven = false;
  private writeAuthorityProven = false;
  private createAttempted = false;
  private readonly root: string;
  private readonly claimRef: string;
  constructor(
    private readonly request: SendOnceAttempt,
    private readonly fetch: HttpFetch,
    private readonly tokenProvider: TokenProvider,
    private readonly proof: ExplicitAuthorityInputs = {},
    private readonly timeoutMs: number = 5_000,
  ) {
    if (!request || !REPO.test(request.repository) ||
        !Number.isSafeInteger(request.prNumber) || request.prNumber < 1 ||
        !ATTEMPT.test(request.attemptId) || !SHA.test(request.headSha))
      throw Error('GITHUB_REQUEST_INVALID');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
      throw Error('GITHUB_DEADLINE_INVALID');
    this.root = `https://api.github.com/repos/${request.repository}`;
    this.claimRef = `refs/bke/claims/${request.prNumber}/${request.attemptId}`;
  }

  /** Every network request and successful JSON response has one abortable deadline. */
  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Error('GITHUB_TRANSPORT_UNCERTAIN'));
      }, this.timeoutMs);
    });
    const work = (async (): Promise<HttpResponse> => {
      let token: string;
      try { token = await this.tokenProvider(); }
      catch { throw Error('GITHUB_AUTH_UNAVAILABLE'); }
      if (typeof token !== 'string' || !token.trim()) throw Error('GITHUB_AUTH_UNAVAILABLE');
      // A late token resolution after the deadline must NEVER start a POST.
      if (controller.signal.aborted) throw Error('GITHUB_TRANSPORT_UNCERTAIN');
      let response: HttpResponse;
      try {
        response = await this.fetch(this.root + path, {
          method, signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body === undefined ? {} : {'Content-Type':'application/json'}),
          },
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
      } catch { throw Error('GITHUB_TRANSPORT_UNCERTAIN'); }
      if (![200, 201, 422].includes(response.status)) return response;
      let parsed: unknown;
      try { parsed = await response.json(); }
      catch { throw Error('GITHUB_RESPONSE_INVALID'); }
      return {status: response.status, json: async () => parsed};
    })();
    try { return await Promise.race([work, deadline]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  private async json(response: HttpResponse): Promise<Record<string, unknown>> {
    try { return record(await response.json()); }
    catch { throw Error('GITHUB_RESPONSE_INVALID'); }
  }

  /** Optional proof path; 404 can denote missing ref only after this succeeds. */
  async proveRepositoryAccess(): Promise<void> {
    const response = await this.call('GET', '');
    if (response.status !== 200) throw Error('GITHUB_REPOSITORY_ACCESS_NOT_PROVEN');
    const repo = await this.json(response);
    if (repo.full_name !== this.request.repository)
      throw Error('GITHUB_REPOSITORY_MISMATCH');
    this.accessProven = true;
  }

  async readAuthority(): Promise<ClaimAuthority> {
    // A failed refresh must never leave an older write grant active.
    this.writeAuthorityProven = false;
    const response = await this.call('GET', `/pulls/${this.request.prNumber}`);
    if (response.status !== 200) throw Error('GITHUB_PR_READ_FAILED');
    const pr = await this.json(response);
    if (pr.number !== this.request.prNumber ||
        (pr.state !== 'open' && pr.state !== 'closed'))
      throw Error('GITHUB_PR_INVALID');
    const headSha = sha(record(pr.head).sha);
    if (!Array.isArray(pr.labels)) throw Error('GITHUB_LABELS_MISSING');
    const owners = pr.labels.map(cleanLabel)
      .filter(label => label.startsWith('bke-worker:'));
    if (owners.length !== 1 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(owners[0]!.slice(11)))
      throw Error('GITHUB_WORKER_ASSIGNMENT_AMBIGUOUS');
    // TODO: these are independent authority inputs, NEVER inferred from PR labels or token presence.
    const p = this.proof;
    if (p.installationRepository !== this.request.repository ||
        p.installationAuthenticated !== true ||
        typeof p.authenticatedWorkerId !== 'string' ||
        !Number.isSafeInteger(p.activeWorkerPrCount) ||
        typeof p.currentAttemptId !== 'string')
      throw Error('GITHUB_EXTERNAL_AUTHORITY_REQUIRED');
    const assignedWorkerId = owners[0]!.slice('bke-worker:'.length);
    this.accessProven = true;
    // Repository reachability is NOT PR/worker send-claim authorization.
    this.writeAuthorityProven = pr.state === 'open' &&
      headSha === this.request.headSha &&
      assignedWorkerId === this.request.workerId &&
      p.authenticatedWorkerId === this.request.workerId &&
      p.activeWorkerPrCount === 1 && p.currentAttemptId === this.request.attemptId;
    return {
      repository: this.request.repository,
      installationRepository: p.installationRepository,
      installationAuthenticated: p.installationAuthenticated,
      prNumber: this.request.prNumber,
      prOpen: pr.state === 'open',
      headSha,
      attemptId: p.currentAttemptId,
      assignedWorkerId,
      authenticatedWorkerId: p.authenticatedWorkerId,
      activeWorkerPrCount: p.activeWorkerPrCount!,
      prWorkerCount: owners.length,
    };
  }

  async readRef(ref: string): Promise<string | null> {
    if (ref !== this.claimRef) throw Error('GITHUB_REF_OUT_OF_SCOPE');
    const path = `/git/ref/${ref.slice('refs/'.length)}`;
    const response = await this.call('GET', path);
    if (response.status === 404) {
      if (!this.accessProven) throw Error('GITHUB_REF_404_ACCESS_UNPROVEN');
      return null;
    }
    if (response.status !== 200) throw Error('GITHUB_REF_READ_FAILED');
    const data = await this.json(response);
    if (data.ref !== ref) throw Error('GITHUB_REF_MISMATCH');
    return sha(record(data.object).sha);
  }

  async createRefIfAbsent(ref: string, headSha: string): Promise<'CREATED' | 'EXISTS'> {
    if (ref !== this.claimRef || headSha !== this.request.headSha ||
        !this.writeAuthorityProven || this.createAttempted)
      throw Error('GITHUB_REF_WRITE_NOT_AUTHORIZED');
    // A lost response irrevocably consumes this instance's single POST attempt.
    this.createAttempted = true;
    this.writeAuthorityProven = false;
    const response = await this.call('POST', '/git/refs', {ref, sha: headSha});
    if (response.status === 422) {
      const data = await this.json(response);
      if (data.message === 'Reference already exists') return 'EXISTS';
      throw Error('GITHUB_REF_VALIDATION_FAILED');
    }
    if (response.status !== 201) throw Error('GITHUB_REF_WRITE_FAILED');
    const data = await this.json(response);
    if (data.ref !== ref || sha(record(data.object).sha) !== headSha)
      throw Error('GITHUB_REF_WRITE_RECEIPT_INVALID');
    return 'CREATED';
  }
}
