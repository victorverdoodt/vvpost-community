// Design system do VVPost. Módulos importam daqui, nunca recriam estes componentes.
export { cx } from './cx'
export {
  Badge,
  InheritanceBadge,
  MethodBadge,
  statusTone,
  toneText,
  type InheritanceKind,
  type Tone
} from './primitives/Badge'
export { Button, buttonClass, controlClass, IconButton, type ButtonProps, type ButtonSize, type ButtonVariant } from './primitives/Button'
export { Kbd } from './primitives/Kbd'
export { SegmentedControl, type SegmentOption } from './primitives/SegmentedControl'
export { EmptyState } from './feedback/EmptyState'
export { ErrorNotice } from './feedback/ErrorNotice'
export {
  describeError,
  FAILURE_LABEL,
  FAILURE_SHORT,
  failureKind,
  type ErrorCategory,
  type ErrorDescription,
  type FailureKind
} from './feedback/errors'
export { ToastProvider, useToast, type ToastTone } from './feedback/Toast'
export { usePromptDialog } from './feedback/PromptDialog'
export { CommandPalette, type Command } from './navigation/CommandPalette'
export {
  cleanEntries,
  menuHeader,
  PanelActiveContext,
  separator,
  useCommandRegistry,
  useContextMenu,
  useMenuCommands,
  type ContextMenuEntries,
  type ContextMenuEntry,
  type ContextMenuHeader,
  type ContextMenuItem
} from './navigation/ContextMenu'
export { TextEditMenu, textEditEntries } from './navigation/TextEditMenu'
export { formatShortcut, isEditableTarget, matchesShortcut, Shortcut } from './navigation/shortcuts'
export { WorkspaceTabs, type WorkspaceTab } from './navigation/WorkspaceTabs'
export { Field, InspectorSection } from './inspectors/InspectorSection'
export { Tabs, type TabItem } from './primitives/Tabs'
export { CodeEditor, formatJson, type CodeLanguage } from './editors/CodeEditor'
export { SchemaForm } from './editors/SchemaForm'
export { SchemaBuilder } from './editors/SchemaBuilder'
export { hasFormFields, parseFormBody, type Schema as JsonSchema } from './editors/schema-form'
export { emptyFind, FindBar, isFindShortcut, type FindState } from './find/FindBar'
export { useDomFind } from './find/useDomFind'
export { InspectorPanel } from './inspectors/InspectorPanel'
export { ResizeHandle, type ResizeEdge } from './layout/ResizeHandle'
export { ResizablePane } from './layout/ResizablePane'
export { SplitHandle, useSplit } from './layout/SplitHandle'
export { DOCK_LABEL, DOCK_REQUEST, dockEntries, DockGrip, dropSide, moveLabel, registerDockHost, requestDock, useDock, useDockHost, type DockHost, type DockSide } from './layout/dock'
export { DockablePane } from './layout/DockablePane'
export { ExecutionToolbar, type ExecutionState } from './execution/ExecutionToolbar'
export { ContextSelector, type ContextField } from './context/ContextSelector'
export { ResponseViewer } from './response/ResponseViewer'
export {
  jsonValueEntries,
  useJsonCommand,
  VariableDialog,
  type JsonValueActions
} from './response/JsonValueMenu'
export { toJsonPath } from './response/jsonpath'
export { jsonPathAt, valueAt } from './response/json-locate'
export { formatBytes, formatDateTime, formatMs, formatTime } from './format'
export {
  AssertionList,
  Collapsible,
  FailedAssertion,
  OutcomeCell,
  OutcomeTotals,
  table,
  type AssertionRow,
  type Outcome
} from './tables/ResultsTable'
export { SecretField } from './secrets/SecretField'
export { SessionStatus } from './identity/SessionStatus'
export { UserMenu } from './identity/UserMenu'
export { OrganizationSwitcher } from './identity/OrganizationSwitcher'
export { PermissionIndicator, rolesFor } from './identity/PermissionIndicator'
export { AuthProviderSelector } from './identity/AuthProviderSelector'
export { SignInView } from './identity/SignInView'
export { PROVIDER_NAME, type AuthProvider, type OrganizationRef, type ProjectPermission } from './identity/types'
