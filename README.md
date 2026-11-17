# OpenCode Unlimited Context

A `/cut` command for [OpenCode](https://opencode.ai). It drops the oldest part of the model request, so you can keep working instead of being compacted.

## Why

You are deep in a codebase. The model is at the sweet spot: it knows the architecture, the conventions, the bug you are chasing, the approaches you already rejected. Then the context fills up and compaction runs. The summary keeps the facts and loses the judgment. You spend the next twenty minutes re-explaining what the model already knew.

If you know the oldest messages are no longer needed, cutting them loses nothing that matters. Everything after the cut stays exactly as it was. No summary, no rewrite, no lost chain of reasoning.

Even with a 1M-token model, a long enough session ends the same way. This gives you the other option.

## Install

Clone it into your OpenCode plugin directory:

```bash
git clone https://github.com/sohommukherjee/opencode-unlimited-context ~/.config/opencode/plugins/cut
```

Add it to `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["./plugins/cut"]
}
```

OpenCode reloads plugins when the config changes. If it does not, run `/reload`.

A local clone gives you the server half: the command and the notices in the chat. The package also ships a TUI half (`./tui`) that shows a corner toast when it is installed as a package. Do not install both forms at once, because both server halves use the same plugin id.

## Use

| Command | Effect |
| --- | --- |
| `/cut` | Drop another 200,000 tokens |
| `/cut 50` | Drop another 50,000 tokens from the oldest end |
| `/cut 50k` | Same thing, if you like the suffix |
| `/cut 10` | Drop another 10,000 tokens |
| `/cut 500` | Drop another 500,000 tokens |
| `/cut -50` | Put the last 50,000 tokens back |
| `/cut 0` | Restore everything that was cut |
| `/cut status` | Report the depth and the last request's numbers |

One number is one thousand tokens. Cuts stack, so `/cut 50` twice is 100k. Restores stack too, and stop at zero rather than going negative.

Every command posts a short notice in the session with the new depth, prefixed with `[cut]` so it is easy to spot. `/cut status` reports the numbers from the last request that actually cut. The notice is tagged in its metadata and stripped from every model request, so it never becomes context and never shifts the cut boundary.

## How it works

The plugin registers the `/cut` command and prepares every request OpenCode sends to the model: the agent loop, compaction summaries, and title generation.

On each request it strips its own notices, then walks the message list from the oldest end and keeps the largest prefix that still fits under the requested depth. If 329k is asked for and the boundaries fall at 320k and 335k, it takes 320k. It never overshoots.

It will not open a request on a tool result, so the edge is pulled back onto the call that produced it. It also never cuts the turn currently being answered, so your latest prompt is always included.

The conversation is never rewritten. The only thing added to the session is the short `[cut]` notice, and that never reaches the model. The cut exists only in the outgoing request, which is why `/cut 0` gives you the entire conversation back on the next message.

## Notes

- Token counts are estimated at four characters per token, so treat them as close rather than exact. Non-Latin text reads low and inline media is counted as a placeholder, not as its real size.
- The transcript in the UI still shows everything. Only the model's copy is trimmed.
- The context meter in the UI updates on the next reply, since that is when the new usage is reported.
- A cut takes effect on the next model request, not at the moment you type the command. `/cut status` says so until that request happens.
- Status and apply lines are written to `/tmp/opencode/cut.log`.

## License

MIT. Take it, change it, ship it.

To the world, with love.
