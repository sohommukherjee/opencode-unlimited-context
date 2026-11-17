import { Plugin } from "@opencode/plugin/tui"
import { readFile } from "node:fs/promises"

// The server half cannot reach the terminal UI, so it writes the last message
// to a small file and this half turns each new value into a toast.
const FILE = "/tmp/opencode/cut.toast"
const VARIANTS = new Set(["info", "success", "warning", "error"])

export default Plugin.define({
  id: "cut-toast",

  async setup(ctx) {
    let last = ""

    const timer = setInterval(async () => {
      try {
        const text = (await readFile(FILE, "utf8")).trim()
        if (!text || text === last) return
        last = text
        const [stamp, sessionID, variant, ...rest] = text.split("|")
        const age = Date.now() - Number(stamp)
        // Ignore anything left over from a previous run or another day.
        if (!Number.isFinite(age) || age > 15_000) return
        ctx.ui.toast.show({
          sessionID: sessionID && sessionID !== "undefined" ? sessionID : undefined,
          message: rest.join("|"),
          variant: VARIANTS.has(variant) ? (variant as "info" | "success" | "warning" | "error") : "info",
          duration: 4000,
        })
      } catch {
        // No toast has been written yet.
      }
    }, 500)

    return () => clearInterval(timer)
  },
})
