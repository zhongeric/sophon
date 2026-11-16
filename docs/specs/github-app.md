# Spec: the GitHub App

Status: phase 1 is built. The Worker calls GitHub as the App `sophon-factory` when its secrets are set.

## Why

- The Worker posts with the owner's token. GitHub does not notify a person about their own comments, so a question
  that the Worker posts is silent, and each post looks as if the owner wrote it.
- With D11, a posted question always needs a person. It must notify them.
- An installation token lasts one hour and covers only the installed repositories. A personal token lasts longer and
  covers more. An App can also read the Checks API, which fine-grained personal tokens cannot.

## The App

| | |
| --- | --- |
| Name | `sophon-factory`, private to `zhongeric` |
| Installed on | `zhongeric/sophon` and `zhongeric/droplet` |
| Permissions | Contents, Pull requests and Issues: read and write. Actions, Commit statuses and Checks: read. |
| Events | Issue comments, Issues, Pull requests, Workflow runs, Statuses, Check suites. The webhook is off until phase 3. |
| Secrets | `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` on the Worker. The key is PKCS#8, as Web Crypto needs. |

## Design

- **Tokens.** `runs.ts` builds the GitHub client from a token provider, not from `GITHUB_TOKEN`. The provider signs
  a JWT with the App key (RS256, Web Crypto), finds the installation of the repository, and gets an installation
  token. It keeps the token until 5 minutes before it expires. For a repository without the App, the run stops
  before any work and gives the install link.
- **Posts.** Comments, PRs and commits come from `sophon-factory[bot]`. A posted question mentions the answerers
  (`@login`), so GitHub notifies them. Only questions of the user level post (D11).
- **Answers.** No change: only unedited `/answer` comments from `ALLOWED_USERS` count. The bot's comments never count.
- **Webhook.** One App webhook replaces the webhook of each repository: one URL and one secret,
  `GITHUB_APP_WEBHOOK_SECRET`. The handler checks each delivery with that secret.
- **CI.** Pushes with an installation token start workflows, as pushes with a personal token do. The run can also
  read CI from the Checks API.
- **Local runs** keep the `gh` login of the user.

## Rollout

| Phase | Change | Exit |
| --- | --- | --- |
| 1 | The token provider. `GITHUB_TOKEN` stays as the fallback when the App secrets are not set. | A development run on sophon where each post comes from the bot. |
| 2 | Questions mention the answerers. | A posted question notifies the owner. |
| 3 | The App webhook, with its own secret. | `/develop` on an issue starts a run without a webhook on the repository. |
| 4 | Remove `GITHUB_TOKEN` and the docs of the webhook for each repository. | The Worker has no personal token. |

Phase 1 also checks whether GitHub marks the bot's commits as verified.
