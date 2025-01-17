import MagicString, {
  type SourceMap,
  type SourceMapOptions,
} from 'magic-string'
import {
  type ParseResult,
  parseAst as rolldownParseAst,
  parseAstAsync as rolldownParseAstAsync,
} from 'rolldown/parseAst'

// TODO: move this compat layer to Rolldown

const parseAstGeneric = (
  code: string,
  opts?: any,
  filename?: string,
): ParseResult => {
  const result = rolldownParseAst(filename ?? 'file.js', code, {
    sourceType: 'module',
    lang: 'js',
    ...opts,
  })
  if (result.errors.length > 0) {
    throw new AggregateError(result.errors)
  }

  return result
}

export const parseAstGenericAsync = async (
  code: string,
  opts?: any,
  filename?: string,
): Promise<ParseResult> => {
  const result = await rolldownParseAstAsync(filename ?? 'file.js', code, {
    sourceType: 'module',
    lang: 'js',
    ...opts,
  })
  if (result.errors.length > 0) {
    throw new AggregateError(result.errors)
  }

  return result
}

export class MagicStringWrapper {
  private oxcMs: ParseResult['magicString']
  private ms: MagicString

  constructor(s: ParseResult['magicString']) {
    this.oxcMs = s
    this.ms = new MagicString(s.toString())
  }

  private getO(pos: number): number {
    return this.oxcMs.getUtf16ByteOffset(pos)
  }

  append(str: string): void {
    this.ms.append(str)
  }

  appendLeft(start: number, str: string): void {
    this.ms.appendLeft(this.getO(start), str)
  }

  prependRight(start: number, str: string): void {
    this.ms.prependRight(this.getO(start), str)
  }

  update(start: number, end: number, str: string): void {
    this.ms.update(this.getO(start), this.getO(end), str)
  }

  move(start: number, end: number, index: number): void {
    this.ms.move(this.getO(start), this.getO(end), this.getO(index))
  }

  remove(start: number, end: number): void {
    this.ms.remove(this.getO(start), this.getO(end))
  }

  generateMap(options: SourceMapOptions): SourceMap {
    return this.ms.generateMap(options)
  }

  toString(): string {
    return this.ms.toString()
  }
}

export const parseAst = (code: string, opts?: any, filename?: string): any => {
  return parseAstGeneric(code, opts, filename).program
}

export const parseAstAsync = async (
  code: string,
  opts?: any,
  filename?: string,
): Promise<any> => {
  const result = await parseAstGenericAsync(code, opts, filename)
  return result.program
}
