# Optional host-selected Automatic approvals

An installed Agent Instance can manage its owner's approval policy across chats.
The adapter can identify the ordinary choice for a permission-profile request,
which otherwise offers two different `allow_once` options. This optional extension
works on ACP v1 and v2 and does not change unnegotiated requests.

The client includes `com.microsoft.amplifier.approval-policy` in the initialize
request's top-level `_meta`, with `version: 1`, `owner: "instance"`, a UUID
`instanceId`, and `automaticChoice: true`. The adapter replies under the same key
with version, owner, `producer: "agentclientprotocol.codex-acp"`, and
`automaticChoice: true`. Missing, null or unsupported metadata is ignored.

For an additional-permissions request, the current tool call's `_meta` contains:

```json
{
  "com.microsoft.amplifier.approval-policy": {
    "automaticChoice": {
      "version": 1,
      "producer": "agentclientprotocol.codex-acp",
      "allowOptionId": "allow_permissions_turn"
    }
  }
}
```

On ACP v2 this tool call is inside `subject`. All original choices remain
available. The default is the ordinary requested **turn** grant, with
`strictAutoReview: false`, matching that existing choice. It is neither the
separate strict-review choice nor a persistent session grant. The host validates
the exact currently offered option before using its own Automatic policy.
Metadata alone authorizes nothing; Ask still requires a decision, and cancellation
still returns the existing empty grant.

This extension does not provide remembered rules, change Codex's configured
approval mode, disable enforced restrictions, or expand the requested permission
profile. The client remains responsible for authenticating its owner and managing
its policy. Ordinary command, file and MCP choices retain their existing behavior.
