const BAD_KEY_RETRY_INTERVAL = 600;
const DEFAULT_ONDEMAND_MODEL = "predefined-claude-4-6-opus";
const ONDEMAND_API_BASE = "https://api.on-demand.io/chat/v1";

const MODEL_ALIASES = {
  "claude-opus-4-6": DEFAULT_ONDEMAND_MODEL,
  "opus-4.6": DEFAULT_ONDEMAND_MODEL,
  "predefined-claude-4-6-opus": DEFAULT_ONDEMAND_MODEL,
};

const EXPOSED_MODELS = [
  "claude-opus-4-6",
  "opus-4.6",
  DEFAULT_ONDEMAND_MODEL,
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

class KeyManager {
  constructor(keyList, retryIntervalSeconds) {
    this.keyList = [...keyList];
    this.retryIntervalSeconds = retryIntervalSeconds;
    this.keyStatus = {};
    this.keyList.forEach((key) => {
      this.keyStatus[key] = { bad: false, badTs: null };
    });
    this.idx = 0;
  }

  displayKey(key) {
    if (!key) return "(empty)";
    if (key.length <= 10) return `${key.slice(0, 2)}...`;
    return `${key.slice(0, 6)}...${key.slice(-4)}`;
  }

  get() {
    const total = this.keyList.length;
    for (let i = 0; i < total; i += 1) {
      const key = this.keyList[this.idx];
      this.idx = (this.idx + 1) % total;
      const status = this.keyStatus[key];

      if (!status.bad) return key;

      if (status.badTs) {
        const age = Date.now() / 1000 - status.badTs;
        if (age >= this.retryIntervalSeconds) {
          status.bad = false;
          status.badTs = null;
          return key;
        }
      }
    }

    this.keyList.forEach((key) => {
      this.keyStatus[key].bad = false;
      this.keyStatus[key].badTs = null;
    });
    this.idx = total > 1 ? 1 : 0;
    return this.keyList[0];
  }

  markBad(key) {
    if (key in this.keyStatus && !this.keyStatus[key].bad) {
      this.keyStatus[key].bad = true;
      this.keyStatus[key].badTs = Date.now() / 1000;
    }
  }
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function parseOnDemandApiKeys(rawValue) {
  if (!rawValue || !String(rawValue).trim()) return [];

  try {
    const parsed = JSON.parse(rawValue);
    if (Array.isArray(parsed)) {
      return parsed.map((key) => String(key).trim()).filter(Boolean);
    }
    if (typeof parsed === "string") {
      return parsed.trim() ? [parsed.trim()] : [];
    }
  } catch (_) {
    // Fall through to comma-separated parsing for local convenience.
  }

  return String(rawValue)
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

function loadConfig(env = {}) {
  const retryInterval = Number.parseInt(
    env.BAD_KEY_RETRY_INTERVAL || String(BAD_KEY_RETRY_INTERVAL),
    10,
  );

  return {
    apiKey: env.OPENAI_API_KEY || "",
    ondemandApiKeys: parseOnDemandApiKeys(env.ONDEMAND_APIKEYS),
    badKeyRetryInterval: Number.isFinite(retryInterval)
      ? retryInterval
      : BAD_KEY_RETRY_INTERVAL,
    ondemandApiBase: env.ONDEMAND_API_BASE || ONDEMAND_API_BASE,
    defaultOndemandModel:
      env.DEFAULT_ONDEMAND_MODEL || DEFAULT_ONDEMAND_MODEL,
    debug: env.DEBUG_MODE === "true",
  };
}

function normalizeModelKey(model) {
  return String(model || "").trim().toLowerCase().replace(/\s+/g, "");
}

function getEndpointId(openaiModel, defaultOndemandModel) {
  const requested = String(openaiModel || "").trim();
  if (!requested) return defaultOndemandModel;
  if (requested.toLowerCase().startsWith("predefined-")) return requested;
  return MODEL_ALIASES[normalizeModelKey(requested)] || defaultOndemandModel;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

function buildOnDemandQuery(messages) {
  if (!Array.isArray(messages)) return "";

  const normalized = messages
    .map((message) => ({
      role: String(message?.role || "user").toLowerCase(),
      content: textFromContent(message?.content),
    }))
    .filter((message) => message.content !== "");

  if (
    normalized.length === 1 &&
    normalized[0].role === "user"
  ) {
    return normalized[0].content;
  }

  return normalized
    .map((message) => `[${message.role.toUpperCase()}]\n${message.content}`)
    .join("\n\n");
}

function openaiError(message, type = "invalid_request_error", code = undefined) {
  return {
    error: {
      message,
      type,
      ...(code ? { code } : {}),
    },
  };
}

async function readErrorText(response) {
  return response.text().catch(() => "");
}

async function throwUpstreamError(response, label) {
  const errorText = await readErrorText(response);
  const error = new Error(
    `${label}: ${response.status}${errorText ? ` ${errorText}` : ""}`,
  );
  error.status = response.status;
  throw error;
}

async function createSession(apikey, apiBase, externalUserId = null) {
  const payload = {
    externalUserId: externalUserId || crypto.randomUUID(),
  };

  const response = await fetch(`${apiBase}/sessions`, {
    method: "POST",
    headers: {
      apikey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await throwUpstreamError(response, "Failed to create OnDemand session");
  }

  const data = await response.json();
  const sessionId = data?.data?.id || data?.id;
  if (!sessionId) {
    throw new Error("OnDemand session response did not include a session id");
  }
  return sessionId;
}

function makeCompletionResponse(openaiModel, content) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: openaiModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function makeStreamChunk(id, created, model, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

function formatOpenaiSse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function extractEventData(eventText) {
  const dataLines = eventText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length > 0) {
    return dataLines.join("\n").trim();
  }

  return eventText.trim();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return null;
}

function deltaFromMaybeCumulativeAnswer(answer, state) {
  if (state.answer && answer.startsWith(state.answer)) {
    const delta = answer.slice(state.answer.length);
    state.answer = answer;
    return delta;
  }

  state.answer += answer;
  return answer;
}

function extractTextDelta(payload, state) {
  const directDelta = firstString(
    payload?.delta,
    payload?.token,
    payload?.content,
    payload?.text,
  );
  if (directDelta !== null) return directDelta;

  const answer = firstString(
    payload?.answer,
    payload?.data?.answer,
    payload?.data?.content,
    payload?.data?.text,
    payload?.data?.message,
  );
  if (answer !== null) return deltaFromMaybeCumulativeAnswer(answer, state);

  if (typeof payload?.data === "string") return payload.data;
  return "";
}

async function postOnDemandQuery(
  config,
  apikey,
  sessionId,
  query,
  endpointId,
  responseMode,
) {
  const response = await fetch(
    `${config.ondemandApiBase}/sessions/${sessionId}/query`,
    {
      method: "POST",
      headers: {
        apikey,
        "Content-Type": "application/json",
        ...(responseMode === "stream"
          ? { Accept: "text/event-stream" }
          : {}),
      },
      body: JSON.stringify({
        query,
        endpointId,
        pluginIds: [],
        responseMode,
      }),
    },
  );

  if (!response.ok) {
    await throwUpstreamError(response, "OnDemand query failed");
  }

  return response;
}

async function handleSyncCompletion(
  config,
  apikey,
  openaiModel,
  endpointId,
  query,
  externalUserId,
) {
  const sessionId = await createSession(
    apikey,
    config.ondemandApiBase,
    externalUserId,
  );
  const response = await postOnDemandQuery(
    config,
    apikey,
    sessionId,
    query,
    endpointId,
    "sync",
  );
  const data = await response.json();
  const answer = firstString(
    data?.data?.answer,
    data?.answer,
    data?.message,
    data?.data?.message,
  ) || "";

  return jsonResponse(makeCompletionResponse(openaiModel, answer));
}

async function handleStreamCompletion(
  config,
  apikey,
  openaiModel,
  endpointId,
  query,
  externalUserId,
) {
  const sessionId = await createSession(
    apikey,
    config.ondemandApiBase,
    externalUserId,
  );
  const upstream = await postOnDemandQuery(
    config,
    apikey,
    sessionId,
    query,
    endpointId,
    "stream",
  );

  if (!upstream.body) {
    throw new Error("OnDemand stream response did not include a body");
  }

  const streamId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();

  const writeSse = (payload) =>
    writer.write(encoder.encode(formatOpenaiSse(payload)));

  (async () => {
    let doneSent = false;
    const state = { answer: "" };

    const finish = async () => {
      if (doneSent) return;
      await writeSse(makeStreamChunk(streamId, created, openaiModel, {}, "stop"));
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      doneSent = true;
    };

    try {
      await writeSse(
        makeStreamChunk(streamId, created, openaiModel, {
          role: "assistant",
        }),
      );

      let buffer = "";
      let upstreamDone = false;

      while (!upstreamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";

        for (const eventText of events) {
          const rawData = extractEventData(eventText);
          if (!rawData) continue;

          if (rawData === "[DONE]") {
            upstreamDone = true;
            break;
          }

          if (rawData.startsWith("[ERROR]:")) {
            await writeSse(
              openaiError(
                rawData.slice("[ERROR]:".length).trim(),
                "server_error",
              ),
            );
            upstreamDone = true;
            doneSent = true;
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            break;
          }

          let payload;
          try {
            payload = JSON.parse(rawData);
          } catch (_) {
            payload = { text: rawData };
          }

          const delta = extractTextDelta(payload, state);
          if (!delta) continue;

          await writeSse(
            makeStreamChunk(streamId, created, openaiModel, {
              content: delta,
            }),
          );
        }
      }

      buffer += decoder.decode();

      if (buffer.trim() && !upstreamDone) {
        const rawData = extractEventData(buffer);
        if (rawData && rawData !== "[DONE]") {
          let payload;
          try {
            payload = JSON.parse(rawData);
          } catch (_) {
            payload = { text: rawData };
          }
          const delta = extractTextDelta(payload, state);
          if (delta) {
            await writeSse(
              makeStreamChunk(streamId, created, openaiModel, {
                content: delta,
              }),
            );
          }
        }
      }

      await finish();
    } catch (error) {
      if (!doneSent) {
        await writeSse(
          openaiError(
            error?.message || "Stream processing failed",
            "server_error",
          ),
        );
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      }
    } finally {
      reader.releaseLock();
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...CORS_HEADERS,
    },
  });
}

async function withValidKey(config, debug, fn) {
  if (config.ondemandApiKeys.length === 0) {
    return jsonResponse(
      openaiError(
        "ONDEMAND_APIKEYS is not configured. Set it as a JSON array or comma-separated secret.",
        "server_error",
        "missing_ondemand_apikeys",
      ),
      500,
    );
  }

  const keyManager = new KeyManager(
    config.ondemandApiKeys,
    config.badKeyRetryInterval,
  );
  const maxRetries = Math.max(config.ondemandApiKeys.length * 2, 1);
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const key = keyManager.get();
    try {
      debug(`Using OnDemand key ${keyManager.displayKey(key)}`);
      return await fn(key);
    } catch (error) {
      lastError = error;
      const status = error?.status;
      if ([401, 403, 429, 500].includes(status)) {
        keyManager.markBad(key);
        continue;
      }
      throw error;
    }
  }

  return jsonResponse(
    openaiError(
      lastError?.message || "No available OnDemand API key.",
      "server_error",
      "ondemand_upstream_error",
    ),
    502,
  );
}

function authenticate(request, config) {
  if (!config.apiKey) {
    return jsonResponse(
      openaiError(
        "OPENAI_API_KEY is not configured on the Worker.",
        "server_error",
        "missing_openai_api_key",
      ),
      500,
    );
  }

  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResponse(
      openaiError(
        "Missing Authorization header. Expected: Bearer YOUR_API_KEY",
        "authentication_error",
        "invalid_api_key",
      ),
      401,
    );
  }

  const providedApiKey = authHeader.slice(7).trim();
  if (providedApiKey !== config.apiKey) {
    return jsonResponse(
      openaiError(
        "Invalid API key.",
        "authentication_error",
        "invalid_api_key",
      ),
      401,
    );
  }

  return null;
}

async function handleChatCompletions(request, config, debug) {
  let data;
  try {
    data = await request.json();
  } catch (error) {
    debug(`JSON parse failed: ${error.message}`);
    return jsonResponse(
      openaiError("Request body is not valid JSON."),
      400,
    );
  }

  if (!Array.isArray(data?.messages)) {
    return jsonResponse(
      openaiError("Request body must include a messages array."),
      400,
    );
  }

  const openaiModel = data.model || config.defaultOndemandModel;
  const endpointId = getEndpointId(openaiModel, config.defaultOndemandModel);
  const query = buildOnDemandQuery(data.messages);

  if (!query) {
    return jsonResponse(
      openaiError("messages must contain at least one non-empty content value."),
      400,
    );
  }

  debug(
    `model=${openaiModel}, endpointId=${endpointId}, stream=${Boolean(
      data.stream,
    )}`,
  );

  return withValidKey(config, debug, (apikey) => {
    if (data.stream) {
      return handleStreamCompletion(
        config,
        apikey,
        openaiModel,
        endpointId,
        query,
        data.user,
      );
    }

    return handleSyncCompletion(
      config,
      apikey,
      openaiModel,
      endpointId,
      query,
      data.user,
    );
  });
}

function handleModels() {
  const created = Math.floor(Date.now() / 1000);
  return jsonResponse({
    object: "list",
    data: EXPOSED_MODELS.map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "ondemand-proxy",
    })),
  });
}

async function handleRequest(request, env) {
  const config = loadConfig(env);
  const debug = (...args) => {
    if (config.debug) console.log("[DEBUG]", ...args);
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (!["/", "/favicon.ico", "/health"].includes(path)) {
    const authError = authenticate(request, config);
    if (authError) return authError;
  }

  if (path === "/" && request.method === "GET") {
    return jsonResponse({
      name: "OnDemand OpenAI-compatible proxy",
      endpoints: ["/v1/chat/completions", "/v1/models"],
      default_model: config.defaultOndemandModel,
    });
  }

  if (path === "/health" && request.method === "GET") {
    return jsonResponse({
      status: "healthy",
      timestamp: new Date().toISOString(),
    });
  }

  if (path === "/v1/models" && request.method === "GET") {
    return handleModels();
  }

  if (path === "/v1/chat/completions" && request.method === "POST") {
    return handleChatCompletions(request, config, debug);
  }

  return jsonResponse(openaiError("Not Found"), 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("[ERROR]", error);
      return jsonResponse(
        openaiError(
          error?.message || "Internal server error.",
          "server_error",
        ),
        500,
      );
    }
  },
};
