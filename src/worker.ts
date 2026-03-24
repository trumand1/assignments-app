export interface Env {
  ASSETS: Fetcher;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
  JIRA_DOMAIN: string;
  JIRA_PROJECT: string;
  GEMINI_API_KEY: string;
}

const GEMINI_MODEL = "gemini-2.5-flash-lite";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (!url.pathname.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      if (url.pathname === "/api/config" && request.method === "GET") {
        return json({ mode: "hosted" });
      }

      if (url.pathname === "/api/parse" && request.method === "POST") {
        return handleParse(request, env);
      }

      if (url.pathname === "/api/jira/search" && request.method === "POST") {
        return handleJiraSearch(request, env);
      }

      if (url.pathname === "/api/jira/issue" && request.method === "POST") {
        return handleJiraIssue(request, env);
      }

      if (url.pathname === "/api/config" || url.pathname === "/api/parse" || url.pathname === "/api/jira/search" || url.pathname === "/api/jira/issue") {
        return json({ error: "Method Not Allowed" }, 405);
      }

      return json({ error: "Not found." }, 404);
    } catch (err) {
      if (err instanceof Response) return err;
      const message = err instanceof Error ? err.message : "Unexpected worker error.";
      return json({ error: message }, 500);
    }
  },
};

async function handleParse(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const imageBase64 = String(body.imageBase64 || "").trim();
  const label = String(body.label || "UNCATEGORIZED").trim() || "UNCATEGORIZED";

  if (!imageBase64) {
    return json({ error: "imageBase64 is required." }, 400);
  }

  requireSecret(env.GEMINI_API_KEY, "GEMINI_API_KEY");

  const prompt = `Extract all assignments from this course management screenshot (Canvas or BYU LearningSuite).

Return ONLY a valid JSON array — no markdown, no backticks, no explanation. Each object must have:
- "name": assignment name (string)
- "dueDate": due date as YYYY-MM-DD using year 2026. If only month/day shown (e.g. "Mar 20"), use 2026. If no date, use null.
- "label": "${label}"

Include all items: homework, labs, quizzes, readings, lectures. Skip section headers like "Unit 4: Strings".

Example: [{"name":"Lab 4a - Strings","dueDate":"2026-03-10","label":"${label}"}]`;

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: "image/png", data: imageBase64 } },
            { text: prompt },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1500 },
      }),
    },
  );

  const data = await parseResponse(upstream);
  if (!upstream.ok) {
    return json({ error: data.error?.message || data.error || `Gemini API error ${upstream.status}` }, upstream.status);
  }

  const text = data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || "";

  try {
    const assignments = JSON.parse(text.replace(/```json|```/g, "").trim());
    return json({ assignments });
  } catch (_err) {
    return json({ error: "Gemini returned an unexpected response." }, 502);
  }
}

async function handleJiraSearch(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const maxResults = Math.min(Math.max(Number(body.maxResults || 100), 1), 100);
  const nextPageToken = body.nextPageToken ? String(body.nextPageToken) : undefined;

  const jira = getJiraConfig(env);
  const searchPayload: Record<string, unknown> = {
    jql: `project="${jira.project}"`,
    fields: ["summary"],
    maxResults,
  };

  if (nextPageToken) searchPayload.nextPageToken = nextPageToken;

  const upstream = await fetch(`https://${jira.domain}/rest/api/3/search/jql`, {
    method: "POST",
    headers: jiraHeaders(jira.email, jira.token),
    body: JSON.stringify(searchPayload),
  });

  return proxyUpstream(upstream, "Jira search failed.");
}

async function handleJiraIssue(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const summary = String(body.summary || "").trim();
  const dueDate = body.dueDate ? String(body.dueDate).trim() : "";
  const label = body.label ? String(body.label).trim() : "";

  if (!summary) {
    return json({ error: "summary is required." }, 400);
  }

  const jira = getJiraConfig(env);
  const fields: Record<string, unknown> = {
    project: { key: jira.project },
    summary,
    issuetype: { name: "Task" },
    labels: label ? [normalizeLabel(label)] : [],
  };

  if (dueDate) {
    fields.duedate = dueDate;
  }

  const upstream = await fetch(`https://${jira.domain}/rest/api/3/issue`, {
    method: "POST",
    headers: jiraHeaders(jira.email, jira.token),
    body: JSON.stringify({ fields }),
  });

  return proxyUpstream(upstream, "Jira issue creation failed.");
}

function getJiraConfig(env: Env) {
  const email = requireSecret(env.JIRA_EMAIL, "JIRA_EMAIL");
  const token = requireSecret(env.JIRA_API_TOKEN, "JIRA_API_TOKEN");
  const domain = normalizeDomain(requireSecret(env.JIRA_DOMAIN, "JIRA_DOMAIN"));
  const project = requireSecret(env.JIRA_PROJECT, "JIRA_PROJECT").trim().toUpperCase();

  if (!domain.endsWith(".atlassian.net")) {
    throw new Error("JIRA_DOMAIN must end with .atlassian.net.");
  }

  return { email, token, domain, project };
}

function requireSecret(value: string | undefined, name: string) {
  if (!value || !value.trim()) {
    throw new Error(`${name} is not configured.`);
  }
  return value;
}

function normalizeDomain(value: string) {
  return value.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function normalizeLabel(value: string) {
  return value.trim().replace(/\s+/g, "_");
}

function jiraHeaders(email: string, token: string) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Basic ${btoa(`${email}:${token}`)}`,
    "User-Agent": "assignments-worker/1.0",
  };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return await request.json() as Record<string, unknown>;
  } catch (_err) {
    throw new Response(JSON.stringify({ error: "Request body must be valid JSON." }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

async function parseResponse(response: Response): Promise<any> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return { error: await response.text() };
}

async function proxyUpstream(response: Response, fallbackMessage: string): Promise<Response> {
  const data = await parseResponse(response);
  if (response.ok) {
    return json(data, response.status);
  }

  const message =
    data.error ||
    data.errorMessages?.[0] ||
    (data.errors ? Object.values(data.errors).join(", ") : "") ||
    fallbackMessage;

  return json({
    error: message,
    errorMessages: data.errorMessages,
    errors: data.errors,
  }, response.status);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
