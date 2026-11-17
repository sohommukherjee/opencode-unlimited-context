import { Plugin } from "@opencode/plugin/tui"
import { readFile } from "node:fs/promises"

// The server half cannot reach the terminal UI, so it writes the last message
// here and this half turns each new value into a toast.
const FILE = "/tmp/opencode/cut.toast"

export default Plugin.define({
  id: "cut-toast",

  async setup(ctx) {
    let last = ""

    const timer = setInterval(async () => {
      try {
        const text = (await readFile(FILE, "utf8")).trim()
        if (!text || text === last) return
        last = text
        const [stamp, variant, ...rest] = text.split("|")
        ctx.ui.toast.show({
          message: rest.join("|"),
          variant: variant as "info" | "success" | "warning" | "error",
          duration: 4000,
        })
      } catch {
        // No toast has been written yet.
      }
    }, 500)

    return () => clearInterval(timer)
  },
})
