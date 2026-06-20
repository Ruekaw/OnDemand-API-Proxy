const BAD_KEY_RETRY_INTERVAL = 600;
const DEFAULT_ONDEMAND_MODEL = "predefined-claude-4-6-opus";
const ONDEMAND_API_BASE = "https://api.on-demand.io/chat/v1";
const ONDEMAND_MEDIA_API_BASE = "https://api.on-demand.io/media/v1/client";

const DEFAULT_MEDIA_PLUGIN_IDS = [
  "plugin-1713954536",
  "plugin-1713958591",
  "plugin-1713958830",
  "plugin-1713967141",
  "plugin-1713961903",
  "plugin-1744182699",
];

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
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Session-Id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "X-Session-Id",
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

function joinUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(path || "")
    .replace(/^\/+/, "")}`;
}

function deriveMediaApiBase(chatApiBase) {
  const normalized = String(chatApiBase || ONDEMAND_API_BASE).replace(/\/+$/, "");
  if (normalized.endsWith("/chat/v1")) {
    return `${normalized.slice(0, -"/chat/v1".length)}/media/v1/client`;
  }
  return ONDEMAND_MEDIA_API_BASE;
}

function loadConfig(env = {}) {
  const retryInterval = Number.parseInt(
    env.BAD_KEY_RETRY_INTERVAL || String(BAD_KEY_RETRY_INTERVAL),
    10,
  );
  const ondemandApiBase = env.ONDEMAND_API_BASE || ONDEMAND_API_BASE;

  return {
    apiKey: env.OPENAI_API_KEY || "",
    ondemandApiKeys: parseOnDemandApiKeys(env.ONDEMAND_APIKEYS),
    badKeyRetryInterval: Number.isFinite(retryInterval)
      ? retryInterval
      : BAD_KEY_RETRY_INTERVAL,
    ondemandApiBase,
    ondemandMediaApiBase:
      env.ONDEMAND_MEDIA_API_BASE || deriveMediaApiBase(ondemandApiBase),
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

function isUnsetValue(value) {
  if (value === undefined || value === null) return true;
  const normalized = String(value).trim().toLowerCase();
  return [
    "",
    "undefined",
    "[undefined]",
    "null",
    "[null]",
  ].includes(normalized);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && !isUnsetValue(value)) return value.trim();
  }
  return "";
}

function extensionFromMimeType(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("pdf")) return "pdf";
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  return "bin";
}

function mediaKindFromMimeType(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized) return "document";
  return "";
}

function mediaKindFromUrl(url) {
  const normalized = String(url || "").split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/.test(normalized)) {
    return "image";
  }
  if (/\.(mp3|m4a|wav|flac|aac|ogg|wma)$/.test(normalized)) {
    return "audio";
  }
  if (/\.(mp4|mov|avi|mkv|webm|m4v|wmv)$/.test(normalized)) {
    return "video";
  }
  if (normalized) return "document";
  return "";
}

function inferMediaName(url, mimeType) {
  if (String(url || "").startsWith("data:")) {
    return `upload.${extensionFromMimeType(mimeType)}`;
  }

  try {
    const pathname = new URL(url).pathname;
    const basename = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
    if (basename) return basename;
  } catch (_) {
    // Not a parseable URL. Fall through to the generic name.
  }

  return `upload.${extensionFromMimeType(mimeType)}`;
}

function normalizeMediaReference(value, fallback = {}) {
  const media = typeof value === "string" ? { url: value } : value;
  if (!media || typeof media !== "object") return null;

  const imageUrl = typeof media.image_url === "string"
    ? media.image_url
    : media.image_url?.url;
  const url = firstNonEmptyString(
    media.url,
    media.uri,
    media.href,
    media.file_url,
    media.fileUrl,
    media.secure_url,
    media.publicUrl,
    media.public_url,
    imageUrl,
    fallback.url,
  );
  const id = firstNonEmptyString(
    media.id,
    media.mediaId,
    media.media_id,
    media.fileId,
    media.file_id,
    fallback.id,
  );
  const mimeType = firstNonEmptyString(
    media.mimeType,
    media.mime_type,
    media.contentType,
    media.content_type,
    typeof media.type === "string" && media.type.includes("/") ? media.type : "",
    fallback.mimeType,
  );

  if (!url && !id) return null;

  const source = firstNonEmptyString(
    media.source,
    fallback.source,
    mediaKindFromMimeType(mimeType),
    mediaKindFromUrl(url),
    "media",
  );
  const name = firstNonEmptyString(
    media.name,
    media.filename,
    media.fileName,
    fallback.name,
    inferMediaName(url, mimeType),
  );

  return {
    ...(id ? { id } : {}),
    ...(url ? { url } : {}),
    name,
    type: mimeType || source,
    source,
    ...(mimeType ? { mimeType } : {}),
    ...(media.searchLevel ? { searchLevel: media.searchLevel } : {}),
    ...(media.plugins ? { plugins: media.plugins } : {}),
    ...(media.pluginIds ? { pluginIds: media.pluginIds } : {}),
    ...(fallback.plugins ? { plugins: fallback.plugins } : {}),
    ...(numberOrString(media.sizeBytes, fallback.sizeBytes)
      ? { sizeBytes: numberOrString(media.sizeBytes, fallback.sizeBytes) }
      : {}),
  };
}

function mediaReferenceFromPart(part) {
  if (!part || typeof part !== "object") return null;

  if (part.type === "image_url" || part.type === "input_image") {
    return normalizeMediaReference(part.image_url || part, {
      source: "image",
      name: "image",
    });
  }

  if (part.type === "image") {
    return normalizeMediaReference(part.image || part, {
      source: "image",
      name: "image",
    });
  }

  if (part.type === "media") {
    return normalizeMediaReference(part.media || part);
  }

  if (part.type === "file" || part.type === "input_file") {
    return normalizeMediaReference(part.file || part, {
      source: "document",
    });
  }

  if (part.image_url) {
    return normalizeMediaReference(part.image_url, {
      source: "image",
      name: "image",
    });
  }

  if (part.media) return normalizeMediaReference(part.media);
  if (part.file) return normalizeMediaReference(part.file, { source: "document" });

  return null;
}

function contentToOnDemandInput(content) {
  const textParts = [];
  const media = [];

  const addText = (value) => {
    if (typeof value === "string") textParts.push(value);
  };

  const visit = (part) => {
    if (typeof part === "string") {
      addText(part);
      return;
    }

    if (!part || typeof part !== "object") return;

    const mediaReference = mediaReferenceFromPart(part);
    if (mediaReference) media.push(mediaReference);

    if (part.type === "text" && typeof part.text === "string") {
      addText(part.text);
      return;
    }

    if (typeof part.text === "string") addText(part.text);
    if (typeof part.content === "string") addText(part.content);
  };

  if (typeof content === "string") {
    addText(content);
  } else if (Array.isArray(content)) {
    content.forEach(visit);
  } else if (content && typeof content === "object") {
    visit(content);
    if (textParts.length === 0 && media.length === 0) {
      addText(JSON.stringify(content));
    }
  } else if (content != null) {
    addText(String(content));
  }

  return {
    text: textParts.filter((text) => text !== "").join("\n"),
    media,
  };
}

function mediaReferenceLine(media) {
  const label = media.source === "image" ? "Image" : "Media";
  const pieces = [`[${label}]`];
  if (media.name) pieces.push(media.name);
  if (media.id) pieces.push(`id=${media.id}`);
  if (media.url && !media.url.startsWith("data:")) pieces.push(`url=${media.url}`);
  return pieces.join(" ");
}

function messageTextForOnDemand(message) {
  return [
    message.text,
    ...message.media.map((media) => mediaReferenceLine(media)),
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function buildOnDemandInput(messages) {
  if (!Array.isArray(messages)) return { query: "", media: [] };

  const normalized = messages
    .map((message) => {
      const input = contentToOnDemandInput(message?.content);
      return {
        role: String(message?.role || "user").toLowerCase(),
        text: input.text,
        media: input.media,
      };
    })
    .filter((message) => message.text !== "" || message.media.length > 0);

  if (
    normalized.length === 1 &&
    normalized[0].role === "user"
  ) {
    return {
      query: messageTextForOnDemand(normalized[0]),
      media: normalized[0].media,
    };
  }

  return {
    query: normalized
      .map((message) => `[${message.role.toUpperCase()}]\n${messageTextForOnDemand(message)}`)
      .join("\n\n"),
    media: normalized.flatMap((message) => message.media),
  };
}

function buildOnDemandQuery(messages) {
  return buildOnDemandInput(messages).query;
}

function valueAsString(value) {
  if (isUnsetValue(value)) return "";
  return String(value).trim();
}

function requestSessionId(request, data = {}) {
  return valueAsString(
    data.sessionId ||
      data.session_id ||
      data.session ||
      request.headers.get("X-Session-Id"),
  );
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

async function readUpstreamBody(response) {
  const contentType = response.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function normalizePluginList(value) {
  if (Array.isArray(value)) {
    const plugins = value.map((plugin) => String(plugin).trim()).filter(Boolean);
    return plugins.length > 0 ? plugins : DEFAULT_MEDIA_PLUGIN_IDS;
  }

  if (typeof value === "string") {
    const plugins = value.split(",").map((plugin) => plugin.trim()).filter(Boolean);
    return plugins.length > 0 ? plugins : DEFAULT_MEDIA_PLUGIN_IDS;
  }

  return DEFAULT_MEDIA_PLUGIN_IDS;
}

function mediaUploadPayload(data) {
  if (data && typeof data === "object" && data.data && typeof data.data === "object") {
    return data.data;
  }
  return data;
}

function numberOrString(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && !isUnsetValue(value)) return value.trim();
  return fallback;
}

function extractPreparedMediaUrl(data, fallbackUrl) {
  const payload = mediaUploadPayload(data);
  if (typeof payload === "string") return payload;
  return firstNonEmptyString(
    payload?.url,
    payload?.secure_url,
    payload?.publicUrl,
    payload?.public_url,
    data?.url,
    data?.secure_url,
    fallbackUrl,
  );
}

function normalizeMediaUploadResponse(data, fallback = {}) {
  const payload = mediaUploadPayload(data);
  const id = firstNonEmptyString(
    payload?.id,
    payload?.mediaId,
    payload?.media_id,
    data?.id,
    data?.mediaId,
    fallback.id,
  );
  const url = firstNonEmptyString(
    payload?.url,
    payload?.secure_url,
    payload?.publicUrl,
    payload?.public_url,
    data?.url,
    data?.secure_url,
    fallback.url,
  );
  const mimeType = firstNonEmptyString(
    payload?.mimeType,
    payload?.mime_type,
    payload?.type,
    fallback.mimeType,
  );

  return {
    ...(id ? { id } : {}),
    ...(url ? { url } : {}),
    name: firstNonEmptyString(payload?.name, data?.name, fallback.name),
    type: mimeType || fallback.type || mediaKindFromUrl(url) || "media",
    source: firstNonEmptyString(
      payload?.source,
      fallback.source,
      mediaKindFromMimeType(mimeType),
      mediaKindFromUrl(url),
      "media",
    ),
    ...(mimeType ? { mimeType } : {}),
    searchLevel: firstNonEmptyString(
      payload?.searchLevel,
      data?.searchLevel,
      fallback.searchLevel,
      "shallow",
    ),
    ...(numberOrString(payload?.sizeBytes, fallback.sizeBytes)
      ? { sizeBytes: numberOrString(payload?.sizeBytes, fallback.sizeBytes) }
      : {}),
  };
}

function isFileLike(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.name === "string"
  );
}

function firstFormFile(formData) {
  for (const [fieldName, value] of formData.entries()) {
    if (isFileLike(value)) return { fieldName, file: value };
  }
  return null;
}

function appendIfMissing(formData, key, value) {
  if (value === undefined || value === null || value === "") return;
  if (!formData.has(key)) formData.append(key, String(value));
}

function addDefaultPlugins(formData, plugins) {
  if (formData.has("plugins")) return;
  normalizePluginList(plugins).forEach((pluginId) => {
    formData.append("plugins", pluginId);
  });
}

function enrichMediaFormData(formData, sessionId, defaults = {}) {
  const formFile = firstFormFile(formData);
  if (formFile && formFile.fieldName !== "file" && !formData.has("file")) {
    formData.append("file", formFile.file, formFile.file.name);
  }

  const file = formFile?.file;
  appendIfMissing(formData, "createdBy", defaults.createdBy || "ondemand-proxy");
  appendIfMissing(formData, "updatedBy", defaults.updatedBy || "ondemand-proxy");
  appendIfMissing(formData, "responseMode", defaults.responseMode || "sync");
  appendIfMissing(formData, "sessionId", sessionId);
  appendIfMissing(formData, "name", defaults.name || file?.name);
  appendIfMissing(formData, "sizeBytes", defaults.sizeBytes || file?.size || 0);
  addDefaultPlugins(formData, defaults.plugins);

  return formFile;
}

function buildMediaMetadata(input, sessionId, responseMode = "sync") {
  const mimeType = firstNonEmptyString(input.mimeType, input.type);
  const name = firstNonEmptyString(input.name, inferMediaName(input.url, mimeType));

  return {
    plugins: normalizePluginList(input.plugins || input.pluginIds),
    createdBy: input.createdBy || input.user || "ondemand-proxy",
    updatedBy: input.updatedBy || input.user || "ondemand-proxy",
    sizeBytes: numberOrString(input.sizeBytes, 0),
    responseMode: input.responseMode || responseMode,
    name,
    url: input.url,
    sessionId,
  };
}

function mediaAuthHeaders(apikey, extraHeaders = {}) {
  return {
    apikey,
    Authorization: `Bearer ${apikey}`,
    ...extraHeaders,
  };
}

async function postMediaJson(config, apikey, path, body, label) {
  const response = await fetch(joinUrl(config.ondemandMediaApiBase, path), {
    method: "POST",
    headers: mediaAuthHeaders(apikey, {
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(body),
  });

  if (!response.ok) await throwUpstreamError(response, label);
  return readUpstreamBody(response);
}

async function prepareRemoteMediaUrl(config, apikey, url) {
  const response = await fetch(joinUrl(config.ondemandMediaApiBase, "/media/upload"), {
    method: "POST",
    headers: mediaAuthHeaders(apikey, {
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    if ([400, 404, 405, 422].includes(response.status)) return null;
    await throwUpstreamError(response, "OnDemand media URL upload failed");
  }

  return readUpstreamBody(response);
}

async function uploadMediaFromUrl(config, apikey, media, sessionId, responseMode) {
  const prepared = await prepareRemoteMediaUrl(config, apikey, media.url);
  const preparedUrl = prepared
    ? extractPreparedMediaUrl(prepared, media.url)
    : media.url;
  const preparedPayload = mediaUploadPayload(prepared);
  const metadata = buildMediaMetadata(
    {
      ...media,
      url: preparedUrl,
      sizeBytes: preparedPayload?.sizeBytes || media.sizeBytes,
    },
    sessionId,
    responseMode,
  );
  const registered = await postMediaJson(
    config,
    apikey,
    "/media",
    metadata,
    "OnDemand media registration failed",
  );
  return normalizeMediaUploadResponse(registered, metadata);
}

function dataUrlToBlob(dataUrl, fallbackName = "upload") {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ""));
  if (!match) return null;

  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const raw = isBase64 ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }

  const name = fallbackName.includes(".")
    ? fallbackName
    : `${fallbackName}.${extensionFromMimeType(mimeType)}`;

  return {
    blob: new Blob([bytes], { type: mimeType }),
    mimeType,
    name,
    size: bytes.byteLength,
  };
}

async function uploadMediaFormData(config, apikey, formData, fallback = {}) {
  let response = await fetch(joinUrl(config.ondemandMediaApiBase, "/media/raw"), {
    method: "POST",
    headers: mediaAuthHeaders(apikey),
    body: formData,
  });

  if (!response.ok && [404, 405].includes(response.status)) {
    response = await fetch(joinUrl(config.ondemandMediaApiBase, "/media/upload"), {
      method: "POST",
      headers: mediaAuthHeaders(apikey),
      body: formData,
    });
  }

  if (!response.ok) {
    await throwUpstreamError(response, "OnDemand raw media upload failed");
  }

  const data = await readUpstreamBody(response);
  return normalizeMediaUploadResponse(data, fallback);
}

async function uploadMediaFromDataUrl(config, apikey, media, sessionId, responseMode) {
  const dataFile = dataUrlToBlob(media.url, media.name || "upload");
  if (!dataFile) {
    throw new Error("Invalid data URL media payload.");
  }

  const formData = new FormData();
  formData.append("file", dataFile.blob, dataFile.name);
  enrichMediaFormData(formData, sessionId, {
    ...media,
    name: dataFile.name,
    mimeType: dataFile.mimeType,
    sizeBytes: dataFile.size,
    responseMode,
  });

  return uploadMediaFormData(config, apikey, formData, {
    ...media,
    name: dataFile.name,
    mimeType: dataFile.mimeType,
    sizeBytes: dataFile.size,
  });
}

async function uploadMediaReference(config, apikey, media, sessionId, responseMode) {
  if (!media?.url || media.id) return media;

  if (media.url.startsWith("data:")) {
    return uploadMediaFromDataUrl(config, apikey, media, sessionId, responseMode);
  }

  return uploadMediaFromUrl(config, apikey, media, sessionId, responseMode);
}

async function attachMediaToSession(config, apikey, sessionId, mediaRefs, responseMode) {
  const uploaded = [];
  for (const media of mediaRefs) {
    uploaded.push(
      await uploadMediaReference(config, apikey, media, sessionId, responseMode),
    );
  }
  return uploaded;
}

async function createSession(apikey, apiBase, externalUserId = null) {
  const payload = {
    agentIds: [],
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

async function getOrCreateSession(
  config,
  apikey,
  providedSessionId,
  externalUserId,
) {
  const sessionId = valueAsString(providedSessionId);
  if (sessionId) return sessionId;
  return createSession(apikey, config.ondemandApiBase, externalUserId);
}

function makeCompletionResponse(openaiModel, content, sessionId = null) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: openaiModel,
    ...(sessionId ? { session_id: sessionId } : {}),
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

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => valueAsString(item)).filter(Boolean);
}

function optionalNumber(value) {
  if (isUnsetValue(value)) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildModelConfigs(data) {
  const modelConfigs = {
    ...(data?.modelConfigs && typeof data.modelConfigs === "object"
      ? data.modelConfigs
      : {}),
  };
  let numberValue;

  numberValue = optionalNumber(data?.max_tokens);
  if (numberValue !== null) modelConfigs.maxTokens = numberValue;
  numberValue = optionalNumber(data?.max_completion_tokens);
  if (numberValue !== null) {
    modelConfigs.maxTokens = numberValue;
  }
  numberValue = optionalNumber(data?.temperature);
  if (numberValue !== null) modelConfigs.temperature = numberValue;
  numberValue = optionalNumber(data?.presence_penalty);
  if (numberValue !== null) {
    modelConfigs.presencePenalty = numberValue;
  }
  numberValue = optionalNumber(data?.frequency_penalty);
  if (numberValue !== null) {
    modelConfigs.frequencyPenalty = numberValue;
  }
  numberValue = optionalNumber(data?.top_p);
  if (numberValue !== null) modelConfigs.topP = numberValue;
  if (typeof data?.stop === "string" && valueAsString(data.stop)) {
    modelConfigs.stopSequences = [valueAsString(data.stop)];
  }
  if (Array.isArray(data?.stop)) modelConfigs.stopSequences = data.stop;

  return Object.keys(modelConfigs).length > 0 ? modelConfigs : null;
}

function optionalBoolean(value) {
  if (isUnsetValue(value)) return null;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return null;
}

function buildQueryPayload(query, data) {
  const modelConfigs = buildModelConfigs(data);
  const reasoningMode = valueAsString(data?.reasoningMode || data?.reasoning_mode);
  const reasoningEffort = valueAsString(
    data?.reasoningEffort || data?.reasoning_effort,
  );
  const useMemory = optionalBoolean(data?.useMemory);

  return {
    query,
    agentIds: arrayOfStrings(data?.agentIds),
    pluginIds: arrayOfStrings(data?.pluginIds),
    ...(modelConfigs ? { modelConfigs } : {}),
    ...(reasoningMode ? { reasoningMode } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(useMemory !== null ? { useMemory } : {}),
  };
}

function isMultipartRequest(request) {
  return (request.headers.get("Content-Type") || "")
    .toLowerCase()
    .includes("multipart/form-data");
}

function isJsonRequest(request) {
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  return !contentType || contentType.includes("application/json");
}

function mediaReferenceFromUploadBody(data) {
  if (data?.media) return normalizeMediaReference(data.media);
  if (data?.file) return normalizeMediaReference(data.file, { source: "document" });
  if (data?.image_url) {
    return normalizeMediaReference(data.image_url, {
      source: "image",
      name: "image",
    });
  }
  return normalizeMediaReference(data);
}

function topLevelMediaReferences(data) {
  const values = Array.isArray(data?.media)
    ? data.media
    : [data?.media, data?.file, data?.image_url].filter(Boolean);
  return values
    .map((value) => normalizeMediaReference(value))
    .filter(Boolean);
}

async function handleMediaUpload(request, config, debug) {
  if (isMultipartRequest(request)) {
    let formData;
    try {
      formData = await request.formData();
    } catch (error) {
      debug(`multipart parse failed: ${error.message}`);
      return jsonResponse(openaiError("Request body is not valid multipart form data."), 400);
    }

    if (!firstFormFile(formData) && !formData.get("url")) {
      return jsonResponse(
        openaiError("multipart upload must include a file field or url field."),
        400,
      );
    }

    const providedSessionId = valueAsString(
      formData.get("sessionId") ||
        formData.get("session_id") ||
        request.headers.get("X-Session-Id"),
    );

    return withValidKey(config, debug, async (apikey) => {
      const sessionId = await getOrCreateSession(
        config,
        apikey,
        providedSessionId,
        valueAsString(formData.get("user")),
      );

      if (formData.get("url") && !firstFormFile(formData)) {
        const media = normalizeMediaReference({
          url: valueAsString(formData.get("url")),
          name: valueAsString(formData.get("name")),
          mimeType: valueAsString(formData.get("mimeType") || formData.get("type")),
          plugins: formData.getAll("plugins"),
          sizeBytes: valueAsString(formData.get("sizeBytes")),
        });
        const uploaded = await uploadMediaReference(
          config,
          apikey,
          media,
          sessionId,
          valueAsString(formData.get("responseMode")) || "sync",
        );
        return jsonResponse(
          { object: "media", sessionId, media: uploaded },
          200,
          { "X-Session-Id": sessionId },
        );
      }

      const formFile = enrichMediaFormData(formData, sessionId);
      const uploaded = await uploadMediaFormData(config, apikey, formData, {
        name: valueAsString(formData.get("name")) || formFile?.file?.name,
        mimeType: formFile?.file?.type,
        sizeBytes: formFile?.file?.size,
      });
      return jsonResponse(
        { object: "media", sessionId, media: uploaded },
        200,
        { "X-Session-Id": sessionId },
      );
    });
  }

  if (!isJsonRequest(request)) {
    return jsonResponse(
      openaiError("Unsupported media upload content type. Use JSON or multipart/form-data."),
      415,
    );
  }

  let data;
  try {
    data = await request.json();
  } catch (error) {
    debug(`media upload JSON parse failed: ${error.message}`);
    return jsonResponse(openaiError("Request body is not valid JSON."), 400);
  }

  const media = mediaReferenceFromUploadBody(data);
  if (!media?.url && !media?.id) {
    return jsonResponse(
      openaiError("JSON upload must include url, image_url, media, or file."),
      400,
    );
  }

  return withValidKey(config, debug, async (apikey) => {
    const sessionId = await getOrCreateSession(
      config,
      apikey,
      requestSessionId(request, data),
      data.user,
    );
    const uploaded = await uploadMediaReference(
      config,
      apikey,
      media,
      sessionId,
      data.responseMode || "sync",
    );
    return jsonResponse(
      { object: "media", sessionId, media: uploaded },
      200,
      { "X-Session-Id": sessionId },
    );
  });
}

async function postOnDemandQuery(
  config,
  apikey,
  sessionId,
  queryPayload,
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
        endpointId,
        query: queryPayload.query,
        agentIds: queryPayload.agentIds || [],
        pluginIds: queryPayload.pluginIds || [],
        responseMode,
        ...(queryPayload.modelConfigs
          ? { modelConfigs: queryPayload.modelConfigs }
          : {}),
        ...(queryPayload.reasoningMode
          ? { reasoningMode: queryPayload.reasoningMode }
          : {}),
        ...(queryPayload.reasoningEffort
          ? { reasoningEffort: queryPayload.reasoningEffort }
          : {}),
        ...(queryPayload.useMemory !== undefined
          ? { useMemory: queryPayload.useMemory }
          : {}),
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
  queryPayload,
  sessionId,
) {
  const response = await postOnDemandQuery(
    config,
    apikey,
    sessionId,
    queryPayload,
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

  return jsonResponse(
    makeCompletionResponse(openaiModel, answer, sessionId),
    200,
    { "X-Session-Id": sessionId },
  );
}

async function handleStreamCompletion(
  config,
  apikey,
  openaiModel,
  endpointId,
  queryPayload,
  sessionId,
) {
  const upstream = await postOnDemandQuery(
    config,
    apikey,
    sessionId,
    queryPayload,
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
      "X-Session-Id": sessionId,
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
  const input = buildOnDemandInput(data.messages);
  const queryPayload = buildQueryPayload(input.query, data);
  const mediaRefs = [
    ...input.media,
    ...topLevelMediaReferences(data),
  ];

  if (!queryPayload.query && mediaRefs.length > 0) {
    queryPayload.query = "Please analyze the attached media.";
  }

  if (!queryPayload.query && mediaRefs.length === 0) {
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

  return withValidKey(config, debug, async (apikey) => {
    const sessionId = await getOrCreateSession(
      config,
      apikey,
      requestSessionId(request, data),
      data.user,
    );

    if (mediaRefs.length > 0) {
      debug(`attaching ${mediaRefs.length} media item(s) to session=${sessionId}`);
      await attachMediaToSession(
        config,
        apikey,
        sessionId,
        mediaRefs,
        data.stream ? "stream" : "sync",
      );
    }

    if (data.stream) {
      return handleStreamCompletion(
        config,
        apikey,
        openaiModel,
        endpointId,
        queryPayload,
        sessionId,
      );
    }

    return handleSyncCompletion(
      config,
      apikey,
      openaiModel,
      endpointId,
      queryPayload,
      sessionId,
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
      endpoints: ["/v1/chat/completions", "/v1/media/upload", "/v1/models"],
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

  if (path === "/v1/media/upload" && request.method === "POST") {
    return handleMediaUpload(request, config, debug);
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
