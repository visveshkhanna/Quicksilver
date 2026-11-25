import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { Inspector } from '../features/inspector/Inspector'
import { Navigator } from '../features/navigator/Navigator'
import { Workspace } from '../features/workspace/Workspace'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'

const SEPARATOR = 'w-px bg-border transition-colors hover:bg-accent data-[separator=active]:bg-accent'

/** The window: title bar, navigator | workspace | inspector, status bar. */
export function App() {
  // Panel sizes survive a restart. Phase 3 moves this into qs-store.
  const layout = useDefaultLayout({ id: 'main-panels', storage: localStorage })

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <Group
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <Panel id="navigator" defaultSize="260px" minSize="180px" maxSize="50%" collapsible>
          <Navigator />
        </Panel>
        <Separator className={SEPARATOR} />
        <Panel id="workspace" minSize="30%">
          <Workspace />
        </Panel>
        <Separator className={SEPARATOR} />
        <Panel id="inspector" defaultSize="280px" minSize="200px" maxSize="40%" collapsible>
          <Inspector />
        </Panel>
      </Group>
      <StatusBar />
    </div>
  )
}
