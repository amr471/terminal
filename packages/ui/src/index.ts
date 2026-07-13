/**
 * @terminal/ui — Bloomberg-style design system: tokens, base components,
 * layout grid, status bar shell, command bar skeleton (F0.5).
 * Consumers import tokens.css + terminal.css alongside these exports.
 */
export {
  color,
  font,
  space,
  layer,
  radius,
  density,
  tokens,
  toCssVariables,
  renderCss,
} from './tokens.js';
export { decDirection, directionClass, type Direction } from './direction.js';
export {
  COMMAND_FUNCTIONS,
  parseCommand,
  isCommandFunction,
  type CommandFunction,
  type ParsedCommand,
} from './command.js';
export { Panel, type PanelProps } from './components/Panel.js';
export { NumCell, type NumCellProps } from './components/NumCell.js';
export { HealthBadge, type HealthBadgeProps } from './components/Badge.js';
export { StatusBar, type StatusBarProps } from './components/StatusBar.js';
export { CommandBar, type CommandBarProps } from './components/CommandBar.js';
export {
  WorkspaceGrid,
  GridArea,
  type WorkspaceGridProps,
  type GridAreaProps,
} from './components/WorkspaceGrid.js';
export {
  IconRail,
  RAIL_SECTIONS,
  type IconRailProps,
  type RailSection,
} from './components/IconRail.js';
export { ResizableColumns, type ResizableColumnsProps } from './components/ResizableColumns.js';
export { TabBar, type TabBarProps, type TabBarTab } from './components/TabBar.js';
export { pixelDeltaToFr, resizeTracks, tracksToCssTemplate } from './resize.js';
export { movePanel, type PanelCoords } from './panelOrder.js';
