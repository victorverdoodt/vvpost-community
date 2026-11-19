import { describe, expect, it } from 'vitest'
import { applyChoices, countConflicts, hasConflictMarkers, parseConflicts } from '../src/shared/conflicts'

const text = [
  '{\n',
  '<<<<<<< HEAD\n',
  '  "name": "Local",\n',
  '=======\n',
  '  "name": "Remoto",\n',
  '>>>>>>> 1a2b3c4 (Renomeia)\n',
  '  "id": "x",\n',
  '<<<<<<< HEAD\n',
  '  "v": 1\n',
  '||||||| merged common ancestors\n',
  '  "v": 0\n',
  '=======\n',
  '  "v": 2\n',
  '>>>>>>> 1a2b3c4 (Renomeia)\n',
  '}\n'
].join('')

describe('conflitos do Git', () => {
  it('separa trechos comuns e blocos, com o ancestral do diff3', () => {
    const segments = parseConflicts(text)
    expect(countConflicts(segments)).toBe(2)
    expect(segments[1]).toMatchObject({ kind: 'conflict', ours: '  "name": "Local",\n', theirs: '  "name": "Remoto",\n', oursLabel: 'HEAD' })
    expect(segments[3]).toMatchObject({ base: '  "v": 0\n', ours: '  "v": 1\n', theirs: '  "v": 2\n' })
  })

  it('aplica uma escolha por bloco e mantém os marcadores dos que faltam', () => {
    const segments = parseConflicts(text)
    expect(applyChoices(segments, ['theirs', 'ours'])).toBe('{\n  "name": "Remoto",\n  "id": "x",\n  "v": 1\n}\n')
    expect(applyChoices(segments, ['both', 'theirs'])).toBe('{\n  "name": "Local",\n  "name": "Remoto",\n  "id": "x",\n  "v": 2\n}\n')
    const partial = applyChoices(segments, ['ours'])
    expect(hasConflictMarkers(partial)).toBe(true)
    expect(countConflicts(parseConflicts(partial))).toBe(1)
  })

  it('marcador sem fechamento é texto comum', () => {
    const odd = '<<<<<<< HEAD\nsó isso\n=======\n'
    expect(parseConflicts(odd)).toEqual([{ kind: 'text', text: odd }])
    expect(hasConflictMarkers(odd)).toBe(false)
  })
})
