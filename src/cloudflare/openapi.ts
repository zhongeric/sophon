const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: unknown) => ({ 'application/json': { schema } })
const target = ['owner', 'repo', 'number'].map((name) => ({ $ref: `#/components/parameters/${name}` }))
const unauthorized = { description: 'No valid ADMIN_TOKEN' }
const badRequest = { description: 'The body is not a JSON object, or the budget is not valid. The text says why.', content: { 'text/plain': { schema: { type: 'string' } } } }

/** A start route: the options in its JSON body, and the run that it started. */
const start = (operationId: string, summary: string, description: string, options: Record<string, unknown>) => ({
  operationId,
  summary,
  description,
  requestBody: { required: false, content: json({ type: 'object', properties: { ...options, budget: ref('Budget') } }) },
  responses: { 202: { description: 'The run', content: json(ref('Started')) }, 400: badRequest, 401: unauthorized },
})

const base = { type: 'string', description: 'The base branch. Default: the default branch of the repository' }
const full = { type: 'boolean', description: 'The full review loop, also when triage allows the light loop' }

/**
 * The OpenAPI description of the admin routes of worker.ts, for the OpenAPI tools of agents and apps. `origin` is the
 * origin of the Worker. The prune route is not in it, because a tool has no need to delete branches.
 */
export function openApi(origin: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'agent-factory',
      version: '1',
      description:
        'Starts and follows agent-factory runs. A development or a research run works on a GitHub issue, and a review run on a PR. ' +
        'The run posts its questions and its report on that issue or PR. The answer to a question is an /answer comment there. Then resumeRun wakes the run.',
    },
    servers: [{ url: origin }],
    security: [{ admin: [] }],
    components: {
      securitySchemes: { admin: { type: 'http', scheme: 'bearer', description: 'The ADMIN_TOKEN of the Worker' } },
      parameters: {
        owner: { name: 'owner', in: 'path', required: true, description: 'The owner of the repository', schema: { type: 'string' } },
        repo: { name: 'repo', in: 'path', required: true, description: 'The name of the repository', schema: { type: 'string' } },
        number: { name: 'number', in: 'path', required: true, description: 'The number of the issue or the PR', schema: { type: 'integer', minimum: 1 } },
      },
      schemas: {
        State: {
          type: 'string',
          enum: ['queued', 'running', 'paused', 'passed', 'failed', 'error'],
          description: 'paused: the run waits for an answer or for CI. error: the run stopped, and resumeRun starts it again from its ledger.',
        },
        Run: {
          type: 'object',
          properties: {
            run: { type: 'string', description: 'The run ID' },
            state: ref('State'),
            note: { type: 'string', description: 'Why the run has this state, for example the reason of a pause' },
            created: { type: 'integer', description: 'When the run started, in ms since 1970' },
          },
          required: ['run', 'state', 'note', 'created'],
        },
        Runs: {
          type: 'object',
          properties: {
            runs: { type: 'array', items: ref('Run'), description: 'The latest run first' },
            result: { description: 'The result of the latest run, or null while it works' },
          },
          required: ['runs', 'result'],
        },
        Started: {
          type: 'object',
          properties: {
            run: { type: 'string', description: 'The run ID' },
            started: { type: 'boolean', description: 'False when a run of this issue or PR is active. Then run is the active run.' },
          },
          required: ['run', 'started'],
        },
        Resumed: {
          type: 'object',
          properties: {
            resumed: { type: 'boolean' },
            state: { anyOf: [ref('State'), { type: 'null' }], description: 'The state of the latest run before the call, or null when there is no run' },
            reason: { type: 'string' },
          },
          required: ['resumed', 'state', 'reason'],
        },
        InboxItem: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['question', 'failed', 'blocked', 'error', 'ready'],
              description: 'question: open questions. error: the run stopped, and resumeRun starts it again. ready: a PR that waits for a merge',
            },
            repository: { type: 'string', description: 'owner/repo' },
            number: { type: 'integer', description: 'The number of the issue or the PR' },
            run: { type: 'string', description: 'The run ID' },
            reason: { type: 'string' },
            link: { type: 'string', description: 'Where you act: the questions, the result or stop comment, or the PR' },
          },
          required: ['kind', 'repository', 'number', 'run', 'reason', 'link'],
        },
        Inbox: {
          type: 'object',
          properties: {
            items: { type: 'array', items: ref('InboxItem') },
            failed: {
              type: 'array',
              description: 'The repositories or installations that the Worker could not read',
              items: { type: 'object', properties: { repository: { type: 'string' }, reason: { type: 'string' } }, required: ['repository', 'reason'] },
            },
          },
          required: ['items', 'failed'],
        },
        Budget: {
          type: 'number',
          exclusiveMinimum: 0,
          description:
            'The cost budget of the run in USD. At the budget, the run posts a notice. At two times the budget, it asks to raise the budget or to stop. Needs MODEL_PRICES on the Worker.',
        },
      },
    },
    paths: {
      '/inbox': {
        get: {
          operationId: 'getInbox',
          summary: 'List what the runs need from you',
          description:
            'For each open issue and PR with a work label in the repositories of the GitHub App: open questions, failed, blocked or stopped runs, and ready PRs that the host did not merge.',
          responses: {
            200: { description: 'The inbox', content: json(ref('Inbox')) },
            401: unauthorized,
            503: { description: 'The Worker has no GitHub App. The text names the missing secrets.', content: { 'text/plain': { schema: { type: 'string' } } } },
          },
        },
      },
      '/runs/{owner}/{repo}/{number}': {
        parameters: target,
        get: {
          operationId: 'getRuns',
          summary: 'List the runs of an issue or a PR',
          description: 'The review runs of a PR, else the development or the research runs of an issue.',
          responses: { 200: { description: 'The runs', content: json(ref('Runs')) }, 401: unauthorized },
        },
        post: start('startReviewRun', 'Start a review run on a PR', 'The run reviews and fixes the PR, and posts its report on the PR.', {
          full,
          ship: { type: 'boolean', description: 'On PASS, push the fixes to the PR branch and mark the PR ready' },
        }),
      },
      '/runs/{owner}/{repo}/{number}/report': {
        parameters: target,
        get: {
          operationId: 'getReport',
          summary: 'Read the report of the latest run of an issue or a PR',
          responses: { 200: { description: 'The report in Markdown, or "no report yet"', content: { 'text/markdown': { schema: { type: 'string' } } } }, 401: unauthorized },
        },
      },
      '/runs/{owner}/{repo}/{number}/resume': {
        parameters: target,
        post: {
          operationId: 'resumeRun',
          summary: 'Wake the latest run of an issue or a PR',
          description: 'Wakes a paused run, for example after an /answer comment. Also starts a run that stopped on an error again, from its ledger.',
          responses: { 202: { description: 'The outcome', content: json(ref('Resumed')) }, 401: unauthorized },
        },
      },
      '/develop/{owner}/{repo}/{number}': {
        parameters: target,
        post: start('startDevelopmentRun', 'Start a development run on an issue', 'The title and the body of the issue are the ask. The run ends in a PR that closes the issue.', {
          base,
          hotfix: { type: 'boolean', description: 'Take the recommendation of every question of the run, also to raise the budget, and ask nobody' },
          full,
          parallel: { type: 'integer', minimum: 1, description: 'At most this many builders at the same time. Default: 3' },
        }),
      },
      '/research/{owner}/{repo}/{number}': {
        parameters: target,
        post: start('startResearchRun', 'Start a research run on a program issue', 'The issue is the program. The repository is the notebook, with the research config.', {
          base,
          parallel: { type: 'integer', minimum: 1, description: 'At most this many surveyors or preregistrars at the same time' },
        }),
      },
    },
  }
}
