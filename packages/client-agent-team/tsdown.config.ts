import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { harnessDir } from '../../scripts/harness-dir.mjs'

const { clientBundle } = await import(pathToFileURL(resolve(harnessDir, 'packages/client/tsdown.client.ts')).href)

const bundle = clientBundle('@wowyuarm/dsh-agent-team', [
  'lib/types/index.js',
])

export default async (options: Parameters<typeof bundle>[0]) => (await bundle(options)).map(entry => {
  const aliases = {
    '@wowyuarm/dsh-agent-team/remote': resolve(import.meta.dirname, '../agent-team/lib/typert.remote-client.js'),
    zod: resolve(import.meta.dirname, '../../node_modules/zod'),
  }
  return {
    ...entry,
    alias: {
      ...(entry as any).alias,
      ...aliases,
    },
    inputOptions: {
      ...entry.inputOptions,
      resolve: {
        ...entry.inputOptions?.resolve,
        alias: {
          ...entry.inputOptions?.resolve?.alias,
          ...aliases,
        },
      },
    },
  }
})
