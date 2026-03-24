# Assignments App

Private assignment-to-Jira helper with two supported modes:

- Hosted mode on Cloudflare Workers with secrets stored server-side.
- Local mode for you or a friend using the browser credentials flow plus `jira_proxy.py`.

## Local mode

Run these commands from the repo root:

```bash
python3 jira_proxy.py
python3 -m http.server 8080
```

Open `http://localhost:8080`. The app will detect that `/api/config` is unavailable and automatically run in local mode.

## Hosted mode

Hosted mode is served by the Cloudflare Worker in `src/worker.ts`. In hosted mode:

- the credentials step is hidden
- parsing goes through `POST /api/parse`
- Jira duplicate lookup goes through `POST /api/jira/search`
- Jira issue creation goes through `POST /api/jira/issue`

Required Worker secrets:

- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `JIRA_DOMAIN`
- `JIRA_PROJECT`
- `GEMINI_API_KEY`

## Cloudflare setup

1. Create a new GitHub repo from this project.
2. Connect that repo to Cloudflare Workers Builds.
3. Add the Worker secrets listed above.
4. Attach the custom domain `assignments.trumandangerfield.com`.
5. In Cloudflare Zero Trust, protect that hostname with an Access application using Email OTP and an allow policy for your exact email address.

## Local friend workflow

A friend with a similar Jira setup can clone the repo and use local mode only. They do not need Cloudflare credentials for that path.
