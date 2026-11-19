import { useState } from 'react'
import { Tabs } from '../design-system'
import { useNavigation } from '../lib/navigate'
import { ExportView } from './import-export/ExportView'
import { ImportView } from './import-export/ImportView'

type Tab = 'import' | 'export'

/**
 * Importar e exportar: coleções do Postman, pacotes do VVPost e specs OpenAPI entram pela mesma
 * revisão e pela camada de escrita do projeto; a exportação gera o pacote do VVPost
 * (bundle.json) com o projeto inteiro ou uma seleção, sem nenhum valor de segredo.
 */
export default function ImportExportPanel() {
  const [tab, setTab] = useState<Tab>('import')
  const [reimport, setReimport] = useState<{ connectorId: string; nonce: number } | undefined>()
  // "Reimportar a spec" no Catálogo abre a revisão aqui.
  useNavigation('import-export', (t) => {
    if (!t.reimportConnectorId) return
    setTab('import')
    setReimport({ connectorId: t.reimportConnectorId, nonce: Date.now() })
  })
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        label="Importar ou exportar"
        idPrefix="import-export"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'import', label: 'Importar' },
          { id: 'export', label: 'Exportar' }
        ]}
      />
      <div role="tabpanel" id={`import-export-panel-${tab}`} className="min-h-0 flex-1">
        {tab === 'import' ? <ImportView reimport={reimport} /> : <ExportView />}
      </div>
    </div>
  )
}
