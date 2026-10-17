import { createEditor } from './test-editor-factory';
import { flushMountedTableLayouts, refreshMountedTablePositions } from '../webview/src/helpers/tables';
import { getViewportController } from '../webview/src/helpers/viewportController';
import { renderMermaidRuntime } from '../webview/src/helpers/mermaidDiagram';
import { preloadMermaidDocumentBatch } from '../webview/src/helpers/mermaidDocumentPreloader';

(window as any).RenderedBlockScrollLayoutHarness = {
  createEditor, flushMountedTableLayouts, refreshMountedTablePositions, getViewportController,
  renderMermaidRuntime, preloadMermaidDocumentBatch
};
