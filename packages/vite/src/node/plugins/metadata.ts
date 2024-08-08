import type { Plugin } from '../plugin'

interface ChunkMetadata {
  importedAssets: Set<string>
  importedCss: Set<string>
}

const chunkMetadataMap = new Map<string, ChunkMetadata>()

/**
 * Prepares the rendered chunks to contain additional metadata during build.
 */
export function metadataPlugin(): Plugin {
  return {
    name: 'vite:build-metadata',

    async renderChunk(_code, chunk) {
      // Since the chunk come from rust side, mutate it directly will not sync back to rust side.
      // The next usage will lost the metadata
      chunkMetadataMap.set(chunk.name, {
        importedAssets: new Set(),
        importedCss: new Set(),
      })
      return null
    },
  }
}

export function getChunkMetadata(name: string): ChunkMetadata | undefined {
  return chunkMetadataMap.get(name)
}