import { createRequire } from 'node:module'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { harnessDir } from './harness-dir.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const harnessRoot = harnessDir
const { WorkspaceAnalyzer } = await import(pathToFileURL(join(harnessRoot, 'packages/typert/generator/src/analyzer.ts')).href)
const { FaceModelEmitter } = await import(pathToFileURL(join(harnessRoot, 'packages/typert/generator/src/emitter.ts')).href)
const { default: ts } = await import(pathToFileURL(join(harnessRoot, 'node_modules/typescript/lib/typescript.js')).href)
const packageRoot = resolve(projectRoot, 'packages/agent-team')
const tempPackage = await mkdtemp(join(harnessRoot, 'packages/external-agent-team-'))
const aggregate = join(tempPackage, 'tsconfig.host.json')

try {
  await cp(join(packageRoot, 'src'), join(tempPackage, 'src'), { recursive: true })
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  await writeFile(join(tempPackage, 'package.json'), JSON.stringify({
    name: manifest.name,
    type: manifest.type,
    exports: {
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './types': { types: './lib/types/types.d.ts', default: './lib/types/types.js' },
    },
  }))
  await mkdir(join(tempPackage, 'node_modules'), { recursive: true })
  // Resolve zod once through the real node_modules chain and COPY it into the
  // temp analysis package. A 'file' symlink is the cheap Linux path but is
  // privilege-gated on Windows and can silently produce a link form the
  // analyzer's TypeScript resolution rejects; a copy is always safe and only
  // costs the package size.
  const req = createRequire(join(projectRoot, 'package.json'))
  const zodSource = dirname(req.resolve('zod/package.json'))
  const zodTarget = join(tempPackage, 'node_modules/zod')
  await cp(zodSource, zodTarget, { recursive: true, dereference: true })
  await writeFile(join(tempPackage, 'tsconfig.json'), JSON.stringify({
    extends: '../../tsconfig.base.json',
    include: ['src'],
    compilerOptions: {
      noEmit: true,
      rootDir: 'src',
      noUnusedLocals: false,
      noUnusedParameters: false,
    },
    references: [{ path: '../../packages/typert/protocol' }],
  }))
  const harnessHost = ts.readConfigFile(join(harnessRoot, 'tsconfig.host.json'), ts.sys.readFile)
  if (harnessHost.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(harnessHost.error.messageText, '\n'))
  const references = (harnessHost.config.references ?? []).map(reference => ({
    path: resolve(harnessRoot, reference.path),
  }))
  references.push({ path: tempPackage })
  await writeFile(aggregate, JSON.stringify({
    extends: join(harnessRoot, 'tsconfig.base.json'),
    files: [],
    compilerOptions: { noEmit: true },
    references,
  }))

  // In reachableFiles, analyzer.ts:860 pushes this.sourceFiles.get(resolvedPath) directly into the
  // crawl queue. If resolvedPath is an unrooted type declaration within copied node_modules,
  // get() returns undefined, which causes sourceFile.fileName to throw on the next queue iteration.
  // On Windows, resolveImport and program.getSourceFiles() can differ by drive-letter casing
  // (e.g. D: vs d:) or slash style, causing this.sourceFiles.get(resolvedPath) to return undefined.
  // We provide a fast fallback in Map.get and filter single undefined pushes to reachableFiles queue.
  const origMapGet = Map.prototype.get
  Map.prototype.get = function (key) {
    const val = origMapGet.call(this, key)
    if (val !== undefined || typeof key !== 'string') return val
    if (this.size > 0 && (key.includes('/') || key.includes('\\'))) {
      const lower = key.replaceAll('\\', '/').toLowerCase()
      for (const [k, v] of this.entries()) {
        if (typeof k === 'string' && k.replaceAll('\\', '/').toLowerCase() === lower) {
          return v
        }
      }
    }
    return undefined
  }
  const origPush = Array.prototype.push
  Array.prototype.push = function (...items) {
    if (items.length === 1 && items[0] === undefined) {
      return this.length
    }
    return origPush.apply(this, items)
  }

  const analyzer = new WorkspaceAnalyzer({
    root: harnessRoot,
    hostConfig: aggregate,
    clientConfig: join(tempPackage, 'tsconfig.client-missing.json'),
    faces: ['host'],
    packages: ['@wowyuarm/dsh-agent-team'],
  })
  const workspace = analyzer.analyze()
  Map.prototype.get = origMapGet
  Array.prototype.push = origPush
  const face = workspace.faces.find(candidate => candidate.face === 'host')
  if (face === undefined) throw new Error('Typert did not analyze the Agent Team Host face')
  const artifact = new FaceModelEmitter(face).emit('@wowyuarm/dsh-agent-team')
  if (artifact.remote === undefined) throw new Error('Typert did not emit the Agent Team Remote contribution')

  const normalizedTemp = tempPackage.replaceAll('\\', '/')
  const generatedRoot = `packages/${normalizedTemp.slice(normalizedTemp.lastIndexOf('/') + 1)}`
  const stable = value => value.replaceAll(generatedRoot, 'packages/agent-team')
  const output = join(packageRoot, 'lib')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'typert.host.js'), stable(artifact.js))
  await writeFile(join(output, 'typert.host.d.ts'), artifact.dts)
  await writeFile(join(output, 'typert.remote-client.js'), stable(artifact.remote.js))
  await writeFile(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
  await writeFile(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
} finally {
  await rm(tempPackage, { recursive: true, force: true })
}
