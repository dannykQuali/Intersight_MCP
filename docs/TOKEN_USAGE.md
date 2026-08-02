# Token usage & result slimming

MCP token cost for this server comes from three places. In descending order of impact (measured against a real session that attributed 34% of usage to this server):

1. **Unbounded `list_*` / `search_resources` results.** A single unfiltered call could return hundreds of full managed objects — e.g. `search_resources` on `kvm/Tunnels` returned **~87k tokens** (350 KB pretty-printed). This was the dominant cost. Note: even when the client diverts a huge result to a file so it does not bloat the *conversation*, the server still generated and returned that volume, which is what the usage meter counts.
2. **Tool schemas.** All-tools mode ships ~16.7k tokens of tool definitions on **every** turn; core mode is ~4.3k. Prefer a focused whitelist over `INTERSIGHT_TOOL_MODE=all` when you don't need write/vKVM tools.
3. **vKVM screenshots.** Each `browser_screenshot` / `vkvm_wait` frame is ~1.9k vision tokens (1600×900); `vkvm_watch` returns two. They also linger in conversation context across turns.

## What the server does automatically

Every tool result passes through `slimResult()` (in `handleToolCall`) before being returned — this covers **all** list/get/search tools at once, and the HTTP path too:

- **Boilerplate stripping.** Heavy, rarely-useful managed-object fields are removed recursively from every result: `Ancestors`, `PermissionResources`, `Owners`, `VersionContext`, `SharedScope`, `DomainGroupMoid`, `AccountMoid`, and the absolute `link` URL inside every MoRef (redundant with `Moid`). Typically a 40–60% per-object reduction.
- **Row cap.** Any `.Results` array longer than the cap (**default 50**) is truncated, with a `_truncated: { returnedRows, totalRows, note }` marker so the agent knows to narrow its query. Configure with the `INTERSIGHT_LIST_CAP` env var (`0` disables the cap).
- **Compact JSON.** Text results are serialized without pretty-print indentation (~15–20% saving).

Image content (`__mcpContent`) passes through untouched. Internal `apiService` calls made *inside* tool handlers are not slimmed — only the final value returned to the model — so server logic that reads stripped fields is unaffected.

Measured effect on the `kvm/Tunnels` search result: **87,505 → 11,952 tokens (−86%)**.

## Scope results at the API level (best practice)

Slimming trims what's returned, but scoping the *query* is even better (less Intersight-side work and network). Use `buildODataQuery()` support where available:

- Prefer `search_resources` with an OData `filter` over a bare `list_*` for targeted lookups (e.g. `Name eq 'BMaaS-Profile'` returns one small object instead of thousands of lines).
- `list_server_profiles` accepts `filter`, `select`, `top`, `orderby`. `$select` in particular collapses payloads to only the fields you need.
- Scope `list_alarms` to the affected server (`filter` on the MoID) rather than an account-wide severity sweep.

Adding `filter`/`select`/`top` to the remaining unbounded `list_*` tools (and defaulting a `$top` at the API layer) is a worthwhile follow-up; the universal row cap above is the safety net until then.
