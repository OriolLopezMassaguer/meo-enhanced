import { createEditor } from './test-editor-factory';
import { getLiveRenderedBlocks } from '../webview/src/helpers/liveRenderedBlocks';
import { bindTooltips } from '../webview/src/adapters/tooltip';
import { applyUiTheme } from '../webview/src/helpers/uiTheme';

(globalThis as typeof globalThis & {
  HtmlContentHarness?: {
    createEditor: typeof createEditor;
    getLiveRenderedBlocks: typeof getLiveRenderedBlocks;
    bindTooltips: typeof bindTooltips;
    applyUiTheme: typeof applyUiTheme;
  };
}).HtmlContentHarness = { createEditor, getLiveRenderedBlocks, bindTooltips, applyUiTheme };
