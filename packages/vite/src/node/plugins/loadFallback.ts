import fsp from 'node:fs/promises'
import type { RolldownPlugin } from 'rolldown'
import { cleanUrl } from '../../shared/utils'

/**
 * A plugin to provide build load fallback for arbitrary request with queries.
 */
export function buildLoadFallbackPlugin(): RolldownPlugin {
  return {
    name: 'vite:load-fallback',
    load: {
      filter: {
        id: {
          exclude: [/^data:/],
        },
      },
      async handler(id) {
        try {
          const cleanedId = cleanUrl(id)
          const content = await fsp.readFile(cleanedId, 'utf-8')
          this.addWatchFile(cleanedId)
          return content
        } catch {
          const content = await fsp.readFile(id, 'utf-8')
          this.addWatchFile(id)
          return content
        }
      },
    },
  }
}
