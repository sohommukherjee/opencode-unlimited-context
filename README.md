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

## Use

| Command | Effect |
| --- | --- |
| `/cut 50` | Drop another 50,000 tokens from the oldest end |
| `/cut 50k` | Same thing, if you like the suffix |
| `/cut 10` | Drop another 10,000 tokens |
| `/cut 500` | Drop another 500,000 tokens |
| `/cut -50` | Put the last 50,000 tokens back |
| `/cut 0` | Restore everything that was cut |
| `/cut status` | Report the current depth and the last request's numbers |

One number is one thousand tokens. Cuts stack, so `/cut 50` twice is 100k. Restores stack too, and stop at zero rather than going negative.

## How it works

The plugin registers the `/cut` command and a `context` hook that runs every time OpenCode assembles a request for the model.

On each request it walks the message list from the oldest end and keeps the largest prefix that still fits under the requested depth. If 329k is asked for and the boundaries fall at 320k and 335k, it takes 320k. It never overshoots.

It will not open a request on a tool result, so the edge is pulled back onto the call that produced it. It also never cuts the turn currently being answered, so your latest prompt is always included.

The stored session is never modified. The cut exists only in the outgoing request, which is why `/cut 0` gives you the entire conversation back on the next message.

## Notes

- Token counts are estimated at four characters per token, so treat them as close rather than exact.
- The transcript in the UI still shows everything. Only the model's copy is trimmed.
- The context meter in the UI updates on the next reply, since that is when the new usage is reported.
- Status and apply lines are written to `/tmp/opencode/cut.log`.

## License

MIT. Take it, change it, ship it.

To the world, with love.
