# Assignments App

Turn an assignment screenshot into Jira tasks.

This repo supports two modes:

- `Local mode`: for anyone cloning the repo and running it on their own machine
- `Hosted mode`: for the private Cloudflare deployment at `assignments.trumandangerfield.com`

If you are cloning this repo, you almost certainly want `Local mode`.

## What cloning users need

Before you run the app, make sure you have:

- `Python 3`
- a Jira Cloud account
- a Jira API token
- a Gemini API key
- a Jira project where you are allowed to create issues

You will enter those values in the app UI. They are not stored in this repo.

## Clone and run locally

From the repo root:

```bash
python3 jira_proxy.py
```

In a second terminal, from the same repo root:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

The app will detect that the Cloudflare API is not present and will automatically use `Local mode`.

## First-time setup in the app

When the app opens in local mode, use the `Credentials` step and enter:

- `Gemini API Key`
- `Jira Email`
- `Jira API Token`
- `Jira Domain`
- `Jira Project Key`

Use these formats:

- `Jira Domain`: `your-company.atlassian.net`
- `Jira Project Key`: something like `CS110` or `ENG`

Do not enter:

- `https://` in the domain field
- `.atlassian.com`
- your Jira password in place of an API token

## How local mode works

Local mode uses:

- the browser UI served from `http://localhost:8080`
- the local proxy in `jira_proxy.py` on `http://localhost:8787`

Why the proxy exists:

- Jira blocks direct browser requests with CORS
- the proxy forwards Jira requests from your machine to Jira

In local mode, your credentials stay on your machine. You provide them through the browser UI, and the local proxy uses them to call Jira.

## Typical local workflow

1. Start `jira_proxy.py`
2. Start `python3 -m http.server 8080`
3. Open `http://localhost:8080`
4. Enter your Gemini and Jira credentials
5. Upload or paste an assignment screenshot
6. Review and edit the parsed assignments
7. Create Jira tasks

## If something fails

### `Failed to fetch` or Jira requests do nothing

Make sure `jira_proxy.py` is running in one terminal.

### `401 Unauthorized`

Usually means one of these:

- wrong Jira email
- wrong Jira API token
- using a password instead of an API token

### Jira domain errors

Use `your-site.atlassian.net`, not `.atlassian.com`.

### Gemini parsing errors

Check that your Gemini API key is valid and has access to the configured model.

## Files cloning users should care about

- `public/index.html`: app shell
- `public/app.js`: frontend behavior
- `jira_proxy.py`: local Jira proxy for cloned/local use

Most cloning users do not need to edit anything to run the app.

## Hosted mode

Hosted mode exists for the private Cloudflare deployment. It uses:

- `src/worker.ts`
- `wrangler.toml`
- Cloudflare Worker secrets

Hosted mode is not required for someone cloning the repo locally.

Required Worker secrets for hosted mode:

- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `JIRA_DOMAIN`
- `JIRA_PROJECT`
- `GEMINI_API_KEY`

## Sharing with a friend

If you share this repo with a friend, tell them:

1. Clone the repo
2. Run `python3 jira_proxy.py`
3. Run `python3 -m http.server 8080`
4. Open `http://localhost:8080`
5. Enter their own Jira and Gemini credentials

They do not need:

- your Cloudflare account
- your deployed site
- your Jira credentials
- your Gemini API key
