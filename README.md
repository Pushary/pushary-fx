# pushary-fx (archived)

This adapter is archived. Do not use it.

It was an experiment against the lifecycle hooks proposed for fx in [vercel-labs/fx#309](https://github.com/vercel-labs/fx/pull/309), which are not in a released fx. An independent review found that it handled several of Pushary's answers incorrectly, including a user's stop and cancel, so the code has been removed.

fx works with Pushary today through the Pushary CLI:

```sh
npx @pushary/agent-hooks@latest setup --agents fx
```

That connects fx to Pushary's tools and sends fx's questions to your phone. When fx releases hooks, Pushary will add phone approvals for fx to the same command.
