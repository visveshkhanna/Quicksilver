import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { ConnectionForm } from '../features/connections/ConnectionForm'
import { PasswordPrompt } from '../features/connections/PasswordPrompt'
import { ConfirmRun, InsertRow, ReviewChanges } from '../features/editing/EditDialogs'
import { Inspector } from '../features/inspector/Inspector'
import { Navigator } from '../features/navigator/Navigator'
import { Shortcuts } from '../features/settings/Shortcuts'
import { CommandPalette, DatabaseSwitcher, GoToObject } from '../features/switcher/Switchers'
import { Workspace } from '../features/workspace/Workspace'
import { useApp } from '../state/app'
import { panelStorage } from '../state/layoutStorage'
import { useShortcuts } from './commands'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'

const SEPARATOR = 'w-px bg-border transition-colors hover:bg-accent data-[separator=active]:bg-accent'

/** The window: title bar, navigator | workspace | inspector, status bar. */
export function App() {
  useShortcuts()
  const panels = useApp((s) => s.panels)
  const dialog = useApp((s) => s.dialog)
  const layout = useDefaultLayout({
    id: `main-panels-${panels.navigator ? 'n' : ''}${panels.inspector ? 'i' : ''}`,
    storage: panelStorage,
  })

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <Group
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        {panels.navigator && (
          <>
            <Panel id="navigator" defaultSize="260px" minSize="180px" maxSize="50%">
              <Navigator />
            </Panel>
            <Separator className={SEPARATOR} />
          </>
        )}
        <Panel id="workspace" minSize="30%">
          <Workspace />
        </Panel>
        {panels.inspector && (
          <>
            <Separator className={SEPARATOR} />
            <Panel id="inspector" defaultSize="280px" minSize="200px" maxSize="40%">
              <Inspector />
            </Panel>
          </>
        )}
      </Group>
      <StatusBar />
      {dialog?.kind === 'switcher' && <DatabaseSwitcher />}
      {dialog?.kind === 'goto' && <GoToObject />}
      {dialog?.kind === 'palette' && <CommandPalette />}
      {dialog?.kind === 'shortcuts' && <Shortcuts />}
      {dialog?.kind === 'connection' && (
        <ConnectionForm profileId={dialog.profileId} pasteUrl={dialog.pasteUrl} />
      )}
      {dialog?.kind === 'review' && <ReviewChanges />}
      {dialog?.kind === 'confirmRun' && <ConfirmRun />}
      {dialog?.kind === 'insertRow' && <InsertRow />}
      <PasswordPrompt />
    </div>
  )
}
