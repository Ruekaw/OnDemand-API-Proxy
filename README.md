# OnDemand API Proxy for SillyTavern

Cloudflare Worker adapter that exposes an OpenAI-compatible API for
OnDemand chat endpoints. It is tuned for SillyTavern's Custom
OpenAI-compatible chat completion mode.

## Endpoints

- `POST /v1/chat/completions`
- `GET /v1/models`
- `GET /health`

## Supported Models

These model names all route to the same OnDemand endpoint:

| OpenAI-compatible model name | OnDemand `endpointId` |
| --- | --- |
| `claude-opus-4-6` | `predefined-claude-4-6-opus` |
| `opus-4.6` | `predefined-claude-4-6-opus` |
| `predefined-claude-4-6-opus` | `predefined-claude-4-6-opus` |

Any request model that already starts with `predefined-` is sent directly as
the OnDemand `endpointId`. Unknown non-`predefined-` model names fall back to
`predefined-claude-4-6-opus`.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Client-facing bearer token used by SillyTavern. |
| `ONDEMAND_APIKEYS` | Yes | OnDemand API keys. Use a JSON array like `["key1","key2"]` or a comma-separated string. |
| `ONDEMAND_API_BASE` | No | Defaults to `https://api.on-demand.io/chat/v1`. |
| `DEFAULT_ONDEMAND_MODEL` | No | Defaults to `predefined-claude-4-6-opus`. |
| `BAD_KEY_RETRY_INTERVAL` | No | Seconds before a failed OnDemand key is retried. Defaults to `600`. |
| `DEBUG_MODE` | No | Set to `true` for Worker debug logs. |

Do not hardcode OnDemand keys in source code. Set `ONDEMAND_APIKEYS` as a
Cloudflare secret, for example:

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put ONDEMAND_APIKEYS
```

## SillyTavern Configuration

- Chat Completion Source: `Custom OpenAI-compatible`
- Base URL: `https://你的worker域名/v1`
- API Key: `OPENAI_API_KEY`
- Model: `claude-opus-4-6`
- Prompt Post-Processing: `Single user message`

`Single user message` is supported directly: if SillyTavern sends one combined
`user` message, the proxy forwards that content unchanged. If a client sends
multiple `system`/`user`/`assistant` messages instead, the proxy merges all
message content into one OnDemand `query` with role labels so character cards
and chat history are not dropped.

## Minimal curl Test

Replace `OPENAI_API_KEY` with the same value configured on the Worker.

```bash
curl https://你的worker域名/v1/chat/completions \
  -H "Authorization: Bearer OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-6",
    "messages": [
      { "role": "user", "content": "Say hello in one short sentence." }
    ]
  }'
```

Streaming test:

```bash
curl -N https://你的worker域名/v1/chat/completions \
  -H "Authorization: Bearer OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-6",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Say hello in one short sentence." }
    ]
  }'
```
