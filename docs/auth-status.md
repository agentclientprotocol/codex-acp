# Authentication status

Codex implements the [Agent Authentication State Query RFD](https://agentclientprotocol.com/rfds/get-auth-state) on ACP v1 and v2. Check for `auth.status: {}` in the agent's capabilities (`agentCapabilities` in v1, `capabilities` in v2). After `initialize`, send `auth/status` with `{}`. No session, sign-in, or token refresh is needed.

| `state` | Meaning |
| --- | --- |
| `authenticated` | Codex reports an account, API key, external credential, or configured gateway. This does not verify that the credential works. |
| `unauthenticated` | Codex requires a login and has none, or recognized an authentication failure. |
| `not_required` | `account/read` found no account and explicitly said that OpenAI authentication is not required. |
| `unknown` | The adapter has not yet been able to read the identity. |

The response is the last observation on this connection. The query refreshes it in the background, sharing an in-flight read with initialization or another query. A slow or unavailable read does not block the query or turn it into an authentication error. Once the adapter observes a change, including a login or logout, it sends `auth/status_update` with the full replacement snapshot:

```json
{"state":"authenticated","accounts":[{"label":"ChatGPT Plus","active":true}]}
```

Use `state` to decide whether to offer sign-in. `accounts` is for display only. A ChatGPT account may include an email and workspace (`organization`), and a gateway may include its display name (`description`). Routing and credentials supplied by the client through `providers/set` are not reported. Older clients can continue to use `_auth/status_update` and the v1 `authentication/status` extension unchanged.
