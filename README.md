# pushary-fx

Phone approvals and "fx needs you" pushes for [fx](https://github.com/vercel-labs/fx), through fx's lifecycle hooks.

> **Status: experimental.** fx lifecycle hooks are proposed in [vercel-labs/fx#309](https://github.com/vercel-labs/fx/pull/309) and are not in a released fx yet. This adapter targets hook schema `1` from that branch and refuses any other version.

## What it does

| fx hook | What happens |
|---|---|
| `PreToolUse` | Before fx runs a terminal command, deletes a file or renames one, Pushary asks on your phone. **Yes**: the call continues. **No**: fx blocks it and tells the agent you denied it. **No answer**: your choice, see `--unanswered`. |
| `AttentionRequired` | When fx stops at a permission, question or route-recovery prompt in the terminal, Pushary sends a push that fx is waiting for you. |

Reads and terminal inspection (`read`, `screen`, `list` and the like) are never sent to Pushary.

## Setup

1. Connect Pushary once. This saves your key to `~/.pushary/config.json` and gives fx the Pushary MCP tools:

   ```sh
   npx @pushary/agent-hooks@latest setup --agents fx
   ```

2. Put `pushary-fx-hook.mjs` somewhere stable, for example `~/.fx/hooks/pushary-fx-hook.mjs`. It needs Node.js 20 or later and has no dependencies.

3. Add the hooks to `~/.fx/settings.json`. fx runs each command without a shell, so use absolute paths (`which node` prints yours):

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "command": ["/usr/local/bin/node", "/Users/you/.fx/hooks/pushary-fx-hook.mjs", "--unanswered", "block"],
           "timeout_ms": 60000
         }
       ],
       "AttentionRequired": [
         {
           "command": ["/usr/local/bin/node", "/Users/you/.fx/hooks/pushary-fx-hook.mjs"],
           "timeout_ms": 8000
         }
       ]
     }
   }
   ```

   fx only reads hooks from your private `~/.fx/settings.json`, never from a repository's `.fx.json`.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--unanswered continue\|block` | `continue` | What to do when the phone gives no answer in time, or Pushary cannot be reached. `continue` hands the call back to fx's own permission check. Use `block` in full-access mode, where fx has no prompt of its own and `continue` would run the call. |
| `--wait-ms N` | `50000` | How long to wait for an answer, from 5000 to 58000. Keep the handler's `timeout_ms` at least 5000 above it: fx blocks the call if the hook overruns. |
| `--gate a,b,c` | `terminal,delete_file,rename_file` | Which fx tools need approval. `terminal` is gated only when it runs something (`exec`, `start`, `write`). |

The key comes from `~/.pushary/config.json`. To use another key, add `PUSHARY_API_KEY` to the handler's `environment` list. `PUSHARY_ENV=test` records questions and pushes in your Pushary activity feed without delivering them.

## What leaves your machine

For a gated call only: the question, the command head (`git push`) or file extension as the target, and the command or path with secrets redacted, capped at 4 KB. Nothing is sent for ungated tools.

## Known limits

- **fx's own prompt still appears after a phone approval** in `ask` and `auto` mode. A hook can continue or block a call, but cannot approve it, so fx asks again in the terminal. In full-access mode the phone is the only gate.
- **The attention push cannot say what fx is waiting for.** `AttentionRequired` carries only the kind of prompt.
- **fx caps hook timeouts at 60 seconds.** An unanswered question is withdrawn after `--wait-ms` and the call falls back to `--unanswered`.

## Test

```sh
node --test
```

## License

MIT
