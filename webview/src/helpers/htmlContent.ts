import { Prec, StateEffect, StateField, type ChangeDesc, type EditorState } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  keymap,
  lineNumberWidgetMarker,
  type DecorationSet
} from '@codemirror/view';
import type { SyntaxNodeRef, Tree } from '@lezer/common';
import { parseDocument } from 'htmlparser2';
import type { ChildNode } from 'domhandler';
import { createElement, AlertTriangle } from 'lucide';
import {
  getHtmlRootTagName,
  isSafeHtmlUrl,
  isSupportedHtmlAttribute,
  isSupportedHtmlBlockSource,
  isSupportedHtmlSource,
  normalizeHtmlAlign,
  sanitizeHtmlStyle,
  supportedHtmlBlockTags,
  supportedHtmlTags
} from '../../../src/shared/htmlPolicy';
import { scanHtmlTags, splitHtmlBlockFragments } from '../../../src/foundation/htmlSyntax';
import { renderHtmlMarkdown } from '../../../src/shared/htmlMarkdown';
import { createOpenLinkButton } from './linkOpenButton';
import { isPrimaryModifierPointerClick } from './linkNavigation';
import { resolvedSyntaxTree } from './markdownSyntax';
import { getViewportController } from './viewportController';
import { ImageWidget } from './images';
import { getImagePresentationFactory } from '../editor/imagePresentation';
import { getDetailsBlocks, toggleDetailsBlock } from './detailsBlocks';
import { UiLanguageSensitiveWidget, uiLanguageFacet } from '../editor/uiLanguage';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { estimateBlockWidgetHeight } from '../editor/blockWidgetHeight';
import { formatSourceLineNumber } from '../editor/sourceLineNumbers';
import { mountProjectedLineNumbers } from '../editor/projectedLineNumbers';
import { RenderedBlockPreviewHeight } from './renderedBlockPreview';
import { createPreviewTableLayoutController, type PreviewTableLayoutController } from './previewTableLayout';

export interface RenderableHtmlBlock {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  source: string;
  detailsCollapsed: boolean | null;
  visible: boolean;
}

export interface HtmlEditingRange {
  from: number;
  to: number;
}

const renderableHtmlBlockCache = new WeakMap<EditorState, {
  tree: any;
  blocks: RenderableHtmlBlock[];
}>();

type HtmlCommentRange = { from: number; to: number };

function maskHtmlComments(source: string): { source: string; comments: HtmlCommentRange[] } | null {
  if (!source.includes('<!--')) return { source, comments: [] };
  const comments: HtmlCommentRange[] = [];
  const visit = (nodes: readonly ChildNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'comment' && node.startIndex !== null && node.endIndex !== null) {
        const raw = source.slice(node.startIndex, node.endIndex + 1);
        if (raw.startsWith('<!--') && raw.endsWith('-->')) {
          comments.push({ from: node.startIndex, to: node.endIndex + 1 });
        }
      }
      if ('children' in node) visit(node.children);
    }
  };
  visit(parseDocument(source, { withStartIndices: true, withEndIndices: true }).children);
  comments.sort((left, right) => left.from - right.from);
  if (comments.length === 0) return null;
  let cursor = 0;
  let masked = '';
  for (const comment of comments) {
    if (source.slice(cursor, comment.from).includes('<!--')) return null;
    masked += source.slice(cursor, comment.from);
    masked += source.slice(comment.from, comment.to).replace(/[^\r\n]/g, ' ');
    cursor = comment.to;
  }
  if (source.slice(cursor).includes('<!--')) return null;
  return { source: masked + source.slice(cursor), comments };
}

function isSupportedHtmlWithComments(source: string): boolean {
  const masked = maskHtmlComments(source);
  return masked !== null && isSupportedHtmlSource(masked.source);
}

function htmlHasVisibleContent(source: string): boolean {
  const transparent = (color: string): boolean => color.toLowerCase() === 'transparent'
    || /^#[\da-f]{3}0$/i.test(color) || /^#[\da-f]{6}00$/i.test(color)
    || /^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?%?\s*\)$/i.test(color)
    || /\/\s*0(?:\.0+)?%?\s*\)$/.test(color);
  const hasInk = (color: string, inherited: boolean): boolean =>
    /^(?:inherit|unset|currentcolor)$/i.test(color) ? inherited : !transparent(color);
  type Paint = { visible: boolean; layout: boolean };
  const paint = (node: ChildNode, ink = true, font = true, shown = true): Paint => {
    if (node.type === 'comment') return { visible: shown && font, layout: font };
    if (node.type === 'text') {
      const layout = Boolean(node.data.trim()) && font;
      return { visible: layout && ink && shown, layout };
    }
    if (!('children' in node) || !('attribs' in node)) return { visible: false, layout: false };
    const style = Object.fromEntries(sanitizeHtmlStyle(node.attribs.style ?? '').split(';')
      .filter(Boolean).map(declaration => declaration.split(':').map(part => part.trim())));
    if ('hidden' in node.attribs || style.display?.toLowerCase() === 'none' || Number(style.opacity) === 0) {
      return { visible: false, layout: false };
    }
    const color = style.color ? hasInk(style.color, ink) : ink;
    const size = style['font-size'];
    const textSize = size ? parseFloat(size) > 0 && (font || !/(?:em|%)$/i.test(size) || /rem$/i.test(size)) : font;
    const visibility = style.visibility ? style.visibility.toLowerCase() === 'visible' : shown;
    const children = node.children.map(child => paint(child, color, textSize, visibility));
    const media = ['img', 'hr', 'br', 'table', 'li'].includes(node.name);
    const sizedBox = parseFloat(style.height ?? style['min-height'] ?? '0') > 0
      && (supportedHtmlBlockTags.has(node.name) || style.display === 'block'
        || style.display === 'inline-block' && parseFloat(style.width ?? '0') > 0);
    const layout = media || sizedBox || children.some(child => child.layout);
    const background = style['background-color'] ?? style.background;
    return { layout, visible: children.some(child => child.visible)
      || visibility && (media || Boolean(background && hasInk(background, color) && layout)) };
  };
  return parseDocument(source).children.some(node => paint(node).visible);
}

function selectedHtmlBlock(state: EditorState): HtmlEditingRange | undefined {
  const { head } = state.selection.main;
  const block = collectRenderableHtmlBlocks(state).find(block => head >= block.from && head < block.to);
  if (block) return block;
  const details = getDetailsBlocks(state).find(block => head >= block.anchorFrom && head < block.anchorTo
    || head >= block.closingFrom && head < block.closingTo);
  return details ? { from: details.sectionFrom, to: details.sectionTo } : undefined;
}

export const setHtmlEditingRangeEffect = StateEffect.define<HtmlEditingRange | null>();

export const htmlEditingRangeField = StateField.define<HtmlEditingRange | null>({
  create() {
    return null;
  },
  update(value, transaction) {
    const previous = value ?? selectedHtmlBlock(transaction.startState);
    let replaced = false;
    if (previous) transaction.changes.iterChangedRanges((from, to) => {
      if (from <= previous.from && to >= previous.to) replaced = true;
    });
    let next = previous && !replaced
      ? { from: transaction.changes.mapPos(previous.from, -1), to: transaction.changes.mapPos(previous.to, 1) }
      : null;
    let explicitlySet = false;
    for (const effect of transaction.effects) {
      if (effect.is(setHtmlEditingRangeEffect)) {
        next = effect.value;
        explicitlySet = true;
      }
    }
    if (!next || explicitlySet || !transaction.selection) return next;
    const head = transaction.state.selection.main.head;
    return head >= next.from && head <= next.to ? next : null;
  }
});

export function getHtmlEditingRange(state: EditorState): HtmlEditingRange | null {
  return state.field(htmlEditingRangeField, false) ?? selectedHtmlBlock(state) ?? null;
}

export function collectRenderableHtmlBlocks(state: EditorState, tree: Tree = resolvedSyntaxTree(state)): RenderableHtmlBlock[] {
  const cached = renderableHtmlBlockCache.get(state);
  if (cached && cached.tree === tree) return cached.blocks;
  const blocks: RenderableHtmlBlock[] = [];
  const detailsByAnchor = new Map(
    getDetailsBlocks(state).map((block) => [block.anchorFrom, block] as const)
  );
  const nodes: Array<{ from: number; to: number; standalone?: boolean }> = [];
  tree.iterate({ enter(node: SyntaxNodeRef) {
    if (node.name === 'HTMLBlock') nodes.push({ from: node.from, to: node.to });
    else if (node.name === 'Paragraph') {
      const source = state.doc.sliceString(node.from, node.to);
      if (!source.trimStart().startsWith('<')) return;
      const fragments = splitHtmlBlockFragments(source);
      let cursor = 0;
      for (const fragment of fragments) {
        if (source.slice(cursor, fragment.from).trim()) return;
        cursor = fragment.to;
      }
      if (fragments.length && !source.slice(cursor).trim()) nodes.push({ from: node.from, to: node.to, standalone: true });
    }
  } });
  // Adjacent raw HTML tokens separated only by blank lines still form one HTML
  // fragment. Markdown paragraphs between them keep their CommonMark ownership.
  const groups: typeof nodes = [];
  for (const node of nodes) {
    const previous = groups.at(-1);
    if (previous && !previous.standalone && !node.standalone && !state.doc.sliceString(previous.to, node.from).trim()) {
      const source = state.doc.sliceString(previous.from, previous.to);
      const fragments = splitHtmlBlockFragments(source);
      const incomplete = !fragments.length || Boolean(source.slice(fragments.at(-1)!.to).trim());
      if (incomplete && supportedHtmlTags.has(getHtmlRootTagName(source) ?? '')) {
        previous.to = node.to;
        continue;
      }
    }
    groups.push({ ...node });
  }
  for (const node of groups) {
    const parsedSource = state.doc.sliceString(node.from, node.to);
    const masked = maskHtmlComments(parsedSource);
    if (!masked) continue;
    const fragments = splitHtmlBlockFragments(masked.source);
    // A single rendered source line cannot host two independent block widgets.
    for (let index = 1; index < fragments.length; index++) {
      const previous = fragments[index - 1], current = fragments[index];
      if (!parsedSource.slice(previous.to, current.from).includes('\n')) {
        previous.to = current.to;
        fragments.splice(index--, 1);
      }
    }
    for (const fragment of fragments) {
      const source = parsedSource.slice(fragment.from, fragment.to);
      if (!(node.standalone ? isSupportedHtmlSource : isSupportedHtmlBlockSource)(masked.source.slice(fragment.from, fragment.to))) continue;
      const visible = htmlHasVisibleContent(renderHtmlMarkdown(source));
      // Inline tags retain ordinary line editing, even when alone in a
      // paragraph. Only an invisible standalone fragment needs a source row.
      if (node.standalone && visible) continue;
      const from = node.from + fragment.from, to = node.from + fragment.to;
      const detailsBlock = detailsByAnchor.get(from) ?? null;
      blocks.push({
        from,
        to,
        startLine: state.doc.lineAt(from).number,
        endLine: state.doc.lineAt(Math.max(node.from, to - 1)).number,
        source,
        detailsCollapsed: detailsBlock?.collapsed ?? null,
        visible
      });
    }
  }
  blocks.sort((left, right) => left.from - right.from);
  renderableHtmlBlockCache.set(state, { tree, blocks });
  return blocks;
}

function currentHtmlBlock(view: EditorView, source: string, startLine: number): RenderableHtmlBlock | undefined {
  // A retained widget may outlive edits before it; absolute offsets in its original block then go stale.
  return collectRenderableHtmlBlocks(view.state).find((block) => (
    block.startLine === startLine && block.source === source
  ));
}

function sanitizeElementTree(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const tagName = element.tagName.toLowerCase();
    if (!supportedHtmlTags.has(tagName)) {
      element.replaceWith(document.createTextNode(element.outerHTML));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!isSupportedHtmlAttribute(tagName, name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === 'href' || name === 'src') && !isSafeHtmlUrl(attribute.value, name)) {
        element.removeAttribute(attribute.name);
      }
      if (name === 'align') {
        const align = normalizeHtmlAlign(attribute.value);
        if (align) element.setAttribute('align', align);
        else element.removeAttribute(attribute.name);
      }
      if (name === 'style') {
        const style = sanitizeHtmlStyle(attribute.value);
        if (style) element.setAttribute('style', style);
        else element.removeAttribute('style');
      }
    }
  }
}

function annotateHtmlSourceLines(root: ParentNode, source: string, startLine: number): void {
  const openingTags = scanHtmlTags(source).filter((tag) => !tag.closing);
  const elements = Array.from(root.querySelectorAll<HTMLElement>('*'));
  let tagCursor = 0;
  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    const tagIndex = openingTags.findIndex((tag, index) => index >= tagCursor && tag.name === tagName);
    if (tagIndex < 0) continue;
    const tag = openingTags[tagIndex];
    tagCursor = tagIndex + 1;
    const relativeLine = source.slice(0, tag.from).split('\n').length - 1;
    element.dataset.meoHtmlSourceLine = String(startLine + relativeLine);
  }
}

function showHtmlComments(
  root: DocumentFragment,
  comments: readonly HtmlCommentRange[],
  view: EditorView,
  source: string,
  sourceFrom: number,
  inline: boolean,
  sourceStartLine: number
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const nodes: Comment[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Comment);
  const sidecarTails = new Map<Element, Element>();
  for (const [index, comment] of comments.entries()) {
    const note = document.createElement('span');
    note.className = 'meo-md-html-comment';
    note.setAttribute('role', 'button');
    note.tabIndex = 0;
    note.dataset.meoHtmlSourceLine = String(sourceStartLine + source.slice(0, comment.from).split('\n').length - 1);
    note.textContent = source.slice(comment.from, comment.to);
    const openSource = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      if (inline) {
        view.dispatch({ selection: { anchor: sourceFrom + comment.from } });
        view.focus();
        return;
      }
      const current = currentHtmlBlock(view, source, sourceStartLine);
      if (current) enterHtmlSource(view, current, current.from + comment.from);
    };
    note.addEventListener('click', openSource);
    note.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') openSource(event);
    });
    const node = nodes[index];
    if (!node) {
      note.dataset.display = 'block';
      root.append(note);
      continue;
    }
    const parent = node.parentElement;
    const structuralParent = parent?.closest('table')
      ?? parent?.closest('ul, ol')
      ?? parent?.closest('a, summary');
    if (structuralParent) {
      note.dataset.display = 'block';
      const tail = sidecarTails.get(structuralParent) ?? structuralParent;
      tail.after(note);
      sidecarTails.set(structuralParent, note);
      node.remove();
      continue;
    }
    note.dataset.display = parent?.matches('p, span, strong, b, em, i, code, kbd, li, td, th') ? 'inline' : 'block';
    node.replaceWith(note);
  }
}

function enhanceLinks(root: ParentNode, inline: boolean, uiLanguage: UiLanguage): void {
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = anchor.getAttribute('href')?.trim() ?? '';
    if (!isSafeHtmlUrl(href, 'href') || !htmlHasVisibleContent(anchor.outerHTML)) continue;
    const linkText = document.createElement('span');
    linkText.className = 'meo-md-link meo-md-html-link';
    linkText.dataset.meoLinkHref = href;
    linkText.dataset.tooltip = anchor.title || anchor.dataset.tooltip || '';
    linkText.dataset.tooltipKind = 'description';
    for (const name of ['id', 'title', 'style', 'hidden', 'lang', 'dir']) {
      if (anchor.hasAttribute(name)) linkText.setAttribute(name, anchor.getAttribute(name)!);
    }
    linkText.append(...Array.from(anchor.childNodes));
    linkText.addEventListener('pointerdown', (event) => {
      if (event.button === 0 && isPrimaryModifierPointerClick(event)) {
        // Native selection can unmount inline HTML before the click arrives.
        event.preventDefault();
      }
    });
    linkText.addEventListener('click', (event) => {
      if (!isPrimaryModifierPointerClick(event)) return;
      event.preventDefault();
      linkText.dispatchEvent(new CustomEvent('meo-open-link', { bubbles: true, detail: { href } }));
    });
    const button = createOpenLinkButton(href, uiLanguage);
    button.classList.add(inline ? 'meo-md-html-inline-link-button' : 'meo-md-html-link-button');
    anchor.replaceWith(linkText, button);
  }
}

function enhanceImages(
  root: ParentNode, view: EditorView, sourceFrom: number, sourceStartLine: number, source: string
): ImageWidget[] {
  const widgets: ImageWidget[] = [];
  const resolveSourceFrom = () => currentHtmlBlock(view, source, sourceStartLine)?.from ?? null;
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))) {
    const rawSrc = image.getAttribute('src')?.trim() ?? '';
    if (!isSafeHtmlUrl(rawSrc, 'src')) continue;
    const anchor = image.closest<HTMLAnchorElement>('a[href]');
    const linkUrl = anchor?.getAttribute('href')?.trim() ?? '';
    const widget = new ImageWidget(
      rawSrc,
      image.getAttribute('alt') ?? '',
      isSafeHtmlUrl(linkUrl, 'href') ? linkUrl : '',
      sourceFrom,
      getImagePresentationFactory(view.state),
      { uiLanguage: view.state.facet(uiLanguageFacet), sourceFromResolver: resolveSourceFrom }
    );
    const container = widget.toDOM(view);
    container.classList.add('meo-md-html-image');
    for (const name of ['id', 'hidden', 'lang', 'dir']) {
      if (image.hasAttribute(name)) container.setAttribute(name, image.getAttribute(name)!);
    }
    const style = image.getAttribute('style');
    if (style) {
      container.style.cssText = style;
    }
    if (image.hasAttribute('hidden')) container.style.display = 'none';
    if (image.dataset.meoHtmlSourceLine) {
      container.dataset.meoHtmlSourceLine = image.dataset.meoHtmlSourceLine;
    }
    const width = image.getAttribute('width')?.trim() ?? '';
    if (!container.style.width && /^\d+(?:\.\d+)?$/.test(width)) {
      container.style.width = `${width}px`;
    }
    const height = image.getAttribute('height')?.trim() ?? '';
    if (!container.style.height && /^\d+(?:\.\d+)?$/.test(height)) container.style.height = `${height}px`;
    if (container.style.width) container.style.setProperty('--meo-html-image-width', '100%');
    if (container.style.height) {
      container.style.setProperty('--meo-html-image-height', '100%');
      container.style.setProperty('--meo-html-image-max-height', 'none');
    }
    const anchorOnlyContainsImage = anchor && Array.from(anchor.childNodes).every((node) => (
      node === image || (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())
    ));
    if (anchorOnlyContainsImage) {
      const wrapper = document.createElement('span');
      for (const name of ['id', 'title', 'style', 'hidden', 'lang', 'dir']) {
        if (anchor.hasAttribute(name)) wrapper.setAttribute(name, anchor.getAttribute(name)!);
      }
      wrapper.append(container);
      anchor.replaceWith(wrapper);
    } else image.replaceWith(container);
    widgets.push(widget);
  }
  return widgets;
}

function createSanitizedHtml(
  source: string,
  inline: boolean,
  uiLanguage: UiLanguage,
  view?: EditorView,
  sourceFrom = 0,
  sourceStartLine = 1
): { fragment: DocumentFragment; imageWidgets: ImageWidget[] } | null {
  const masked = maskHtmlComments(source);
  const rendered = renderHtmlMarkdown(source, inline);
  const renderedMask = maskHtmlComments(rendered);
  if (!masked || !renderedMask || !isSupportedHtmlSource(renderedMask.source)) return null;
  const template = document.createElement('template');
  template.innerHTML = rendered;
  sanitizeElementTree(template.content);
  annotateHtmlSourceLines(template.content, masked.source, sourceStartLine);
  if (view && masked.comments.length) {
    showHtmlComments(template.content, masked.comments, view, source, sourceFrom, inline, sourceStartLine);
  }
  const imageWidgets = view
    ? enhanceImages(template.content, view, sourceFrom, sourceStartLine, source)
    : [];
  enhanceLinks(template.content, inline, uiLanguage);
  return { fragment: template.content, imageWidgets };
}

function preserveHtmlPosition(view: EditorView, mutate: () => void): void {
  const controller = getViewportController(view);
  if (controller) controller.preserveScrollPosition(mutate);
  else mutate();
}

export function enterHtmlSource(view: EditorView, block: HtmlEditingRange, anchor?: number): void {
  const currentSelection = view.state.selection;
  const selection = anchor === undefined && currentSelection.ranges.every((range) => (
    range.from >= block.from && range.to <= block.to
  )) ? currentSelection : { anchor: anchor ?? block.from };
  preserveHtmlPosition(view, () => {
    view.dispatch({
      selection,
      effects: setHtmlEditingRangeEffect.of({ from: block.from, to: block.to }),
      scrollIntoView: false
    });
  });
  view.focus();
}

type HtmlTableLayout = { frame: number | null; controller: PreviewTableLayoutController | null };
// CodeMirror may retain a widget's DOM while replacing its equal value object.
const htmlTableLayouts = new WeakMap<HTMLElement, HtmlTableLayout>();

class HtmlBlockWidget extends UiLanguageSensitiveWidget {
  private imageWidgets: ImageWidget[] = [];
  private readonly height: RenderedBlockPreviewHeight;

  constructor(readonly block: RenderableHtmlBlock, readonly editing = false) {
    super();
    this.height = new RenderedBlockPreviewHeight(JSON.stringify(['html', block.source, block.detailsCollapsed]));
  }

  seedHeight(previous: HtmlBlockWidget): void {
    this.height.seed(previous.height);
  }

  get estimatedHeight(): number {
    return estimateBlockWidgetHeight({
      kind: 'html-block',
      source: this.block.source,
      collapsed: this.block.detailsCollapsed === true,
      measuredHeight: this.height.height
    });
  }

  eq(other: WidgetType): boolean {
    return other instanceof HtmlBlockWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.block.startLine === this.block.startLine &&
      other.editing === this.editing &&
      other.block.source === this.block.source &&
      other.block.detailsCollapsed === this.block.detailsCollapsed;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div');
    root.className = 'meo-md-html-block';
    root.dataset.meoRenderedBlockKind = 'html';
    root.dataset.meoRenderedBlockStartLine = String(this.block.startLine);
    root.dataset.meoRenderedBlockEndLine = String(this.block.endLine);
    root.classList.toggle('meo-md-html-live-result', this.editing);
    const contentRoot = document.createElement('div');
    contentRoot.className = 'meo-md-html-content';
    const content = createSanitizedHtml(
      this.block.source,
      false,
      view.state.facet(uiLanguageFacet),
      view,
      this.block.from,
      this.block.startLine
    );
    if (content) {
      this.imageWidgets = content.imageWidgets;
      const firstElement = content.fragment.firstElementChild as HTMLElement | null;
      const align = normalizeHtmlAlign(firstElement?.getAttribute('align') ?? null);
      if (align) root.style.textAlign = align;
      contentRoot.appendChild(content.fragment);
    }
    root.appendChild(contentRoot);

    const details = contentRoot.querySelector<HTMLDetailsElement>(':scope > details');
    const summary = details?.querySelector<HTMLElement>(':scope > summary') ?? null;
    if (summary) {
      const label = document.createElement('span');
      label.className = 'meo-md-details-summary-label';
      label.append(...Array.from(summary.childNodes));
      const icon = document.createElement('span');
      icon.className = 'meo-md-details-summary-icon';
      icon.setAttribute('aria-hidden', 'true');
      summary.append(icon, label);
    }
    if (details && this.block.detailsCollapsed !== null) {
      details.open = !this.block.detailsCollapsed;
      details.addEventListener('toggle', () => {
        const currentBlock = currentHtmlBlock(view, this.block.source, this.block.startLine);
        if (!currentBlock) return;
        const collapsed = getDetailsBlocks(view.state)
          .find((block) => block.anchorFrom === currentBlock.from)?.collapsed;
        if (collapsed === undefined || details.open === !collapsed) return;
        toggleDetailsBlock(view, currentBlock.from);
      });
    }

    // Wait until pointerup/click so native dragging can select rendered text.
    // Interactive HTML keeps its own reading action and never opens source.
    let pointer: { x: number; y: number } | null = null;
    root.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (this.editing) event.preventDefault();
    });
    root.addEventListener('click', event => {
      const start = pointer;
      pointer = null;
      const target = event.target instanceof Element ? event.target : null;
      if (this.editing || !start || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
        || target?.closest('summary, button, a, input, select, textarea, .meo-md-html-comment, .meo-md-image')) return;
      const selection = root.ownerDocument.getSelection();
      if (selection && !selection.isCollapsed && root.contains(selection.anchorNode)) return;
      const currentBlock = currentHtmlBlock(view, this.block.source, this.block.startLine);
      if (!currentBlock) return;
      const line = Number(target?.closest<HTMLElement>('[data-meo-html-source-line]')?.dataset.meoHtmlSourceLine);
      const anchor = Number.isInteger(line) && line > 0 && line <= view.state.doc.lines
        ? Math.max(currentBlock.from, Math.min(currentBlock.to, view.state.doc.line(line).from)) : undefined;
      event.preventDefault();
      enterHtmlSource(view, currentBlock, anchor);
    });
    this.height.observe(root, view);
    if (contentRoot.querySelector('table')) {
      // The widget is not mounted during toDOM. Its natural table geometry is
      // meaningful only after CodeMirror attaches it; dispose with this widget.
      const layout: HtmlTableLayout = { frame: null, controller: null };
      htmlTableLayouts.set(root, layout);
      layout.frame = requestAnimationFrame(() => {
        layout.frame = null;
        if (htmlTableLayouts.get(root) === layout && root.isConnected) {
          layout.controller = createPreviewTableLayoutController(root.ownerDocument, contentRoot);
        }
      });
    }
    return root;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    const layout = htmlTableLayouts.get(dom);
    if (layout && layout.frame !== null) cancelAnimationFrame(layout.frame);
    layout?.controller?.dispose();
    htmlTableLayouts.delete(dom);
    this.height.destroy(dom);
    for (const widget of this.imageWidgets) widget.destroy();
    this.imageWidgets = [];
  }
}

type HtmlDetailsLineNumberColumn = HTMLDivElement & {
  __meoHtmlDetailsLineNumberCleanup?: () => void;
};

const htmlDetailsSemanticLineSelector = [
  'summary',
  'p',
  'blockquote',
  'ul',
  'ol',
  'li',
  'div',
  'table',
  '.meo-md-html-image'
].map((selector) => `[data-meo-html-source-line]:is(${selector})`).join(',');

class HtmlBlockLineNumberMarker extends GutterMarker {
  elementClass: string;

  constructor(private readonly block: RenderableHtmlBlock, private readonly lineNumbers: readonly string[]) {
    super();
    this.elementClass = block.detailsCollapsed === null ? '' : 'meo-md-html-details-line-numbers';
  }

  eq(other: GutterMarker): boolean {
    return other instanceof HtmlBlockLineNumberMarker &&
      other.block.startLine === this.block.startLine &&
      other.block.source === this.block.source &&
      other.block.detailsCollapsed === this.block.detailsCollapsed
      && other.lineNumbers.length === this.lineNumbers.length
      && other.lineNumbers.every((number, index) => number === this.lineNumbers[index]);
  }

  toDOM(view: EditorView): Node {
    if (this.block.detailsCollapsed === null) {
      return document.createTextNode(this.lineNumbers[0]);
    }

    const column = document.createElement('div') as HtmlDetailsLineNumberColumn;
    column.className = 'meo-md-html-details-line-number-column';
    column.__meoHtmlDetailsLineNumberCleanup = mountProjectedLineNumbers(view, column,
      'meo-md-html-details-line-number', () => {
        const root = view.dom.querySelector<HTMLElement>(
          `.meo-md-html-block[data-meo-rendered-block-start-line="${this.block.startLine}"]`);
        const details = root?.querySelector<HTMLDetailsElement>(':scope > .meo-md-html-content > details');
        if (!root || !details) return null;
        const top = column.getBoundingClientRect().top;
        const positions = new Map<number, { line: number; top: number; height: number }>();
        const elements = Array.from(details.querySelectorAll<HTMLElement>(htmlDetailsSemanticLineSelector));
        for (const element of elements) {
          const line = Number(element.dataset.meoHtmlSourceLine), rect = element.getBoundingClientRect();
          if (!Number.isInteger(line) || rect.height < 1 || getComputedStyle(element).display === 'none') continue;
          const key = Math.round(rect.top), previous = positions.get(key);
          if (!previous || line >= previous.line) positions.set(key, { line, top: rect.top - top, height: rect.height });
        }
        const rows = Array.from(positions.values()).sort((left, right) => left.top - right.top)
          .map((row, index) => ({ key: `${row.line}:${index}`, label: this.lineNumbers[row.line - this.block.startLine] ?? '',
            top: row.top, height: row.height }));
        return { rows, elements: [root, ...elements], mutations: [details] };
      });
    return column;
  }

  destroy(dom: Node): void {
    (dom as HtmlDetailsLineNumberColumn).__meoHtmlDetailsLineNumberCleanup?.();
  }
}

const htmlBlockLineNumberMarker = lineNumberWidgetMarker.of((view, widget, block) => {
  if (!(widget instanceof HtmlBlockWidget) || widget.editing || block.height < 1) return null;
  return new HtmlBlockLineNumberMarker(widget.block,
    Array.from({ length: widget.block.endLine - widget.block.startLine + 1 }, (_, index) =>
      formatSourceLineNumber(widget.block.startLine + index, view.state)));
});

class HtmlWarningWidget extends WidgetType {
  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const warning = document.createElement('span');
    warning.className = 'meo-md-html-warning';
    warning.dataset.tooltip = strings.unsupportedHtmlSource;
    warning.setAttribute('aria-label', warning.dataset.tooltip ?? '');
    warning.appendChild(createElement(AlertTriangle, { width: 14, height: 14, 'aria-hidden': 'true' }));
    return warning;
  }
}

class InlineHtmlWidget extends UiLanguageSensitiveWidget {
  constructor(readonly source: string, readonly from: number, readonly startLine: number) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof InlineHtmlWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.source === this.source && other.from === this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'meo-md-html-inline';
    const content = createSanitizedHtml(
      this.source, true, view.state.facet(uiLanguageFacet), view, this.from, this.startLine
    );
    if (content) wrapper.appendChild(content.fragment);
    const firstElement = wrapper.firstElementChild;
    if (firstElement) {
      const tagName = firstElement.tagName.toLowerCase();
      firstElement.classList.add(`meo-md-html-${tagName === 'b' ? 'strong' : tagName}`);
    }
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function addInlineHtmlDecorations(
  ranges: any[],
  state: EditorState,
  activeLines: ReadonlySet<number>,
  blockRanges: readonly RenderableHtmlBlock[],
  inlineRanges: Array<{ from: number; to: number }>
): void {
  const tagStarts = new Set<number>();
  const tagEnds = new Set<number>();
  resolvedSyntaxTree(state).iterate({ enter(node) {
    if (node.name === 'HTMLTag') {
      tagStarts.add(node.from);
      tagEnds.add(node.to);
    }
  } });
  const inlineTags = new Set(['strong', 'b', 'em', 'i', 'del', 's', 'mark', 'code', 'span', 'sub', 'sup', 'u', 'a', 'ruby', 'abbr', 'q', 'small', 'img']);
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    if (activeLines.has(lineNo)) continue;
    const line = state.doc.line(lineNo);
    if (blockRanges.some((block) => line.from < block.to && line.to > block.from)) continue;
    for (const fragment of splitHtmlBlockFragments(line.text)) {
      const source = line.text.slice(fragment.from, fragment.to);
      if (!inlineTags.has(getHtmlRootTagName(source) ?? '') || !isSupportedHtmlWithComments(source)) continue;
      const from = line.from + fragment.from;
      const to = line.from + fragment.to;
      // Only actual HTML syntax may replace source; code, escapes, comments and scripts are literal.
      if (!tagStarts.has(from) || !tagEnds.has(to)) continue;
      ranges.push(Decoration.replace({
        widget: new InlineHtmlWidget(source, from, lineNo),
        inclusive: false
      }).range(from, to));
      inlineRanges.push({ from, to });
    }
  }
}

export function addHtmlContentDecorations(
  ranges: any[],
  state: EditorState,
  activeLines: ReadonlySet<number>,
  previousDecorations?: DecorationSet,
  changes?: ChangeDesc,
  inlineRanges: Array<{ from: number; to: number }> = []
): RenderableHtmlBlock[] {
  const editingRange = getHtmlEditingRange(state);
  const blocks = collectRenderableHtmlBlocks(state);
  const addSourceRange = (range: HtmlEditingRange, invalid = false, invisible = false): void => {
    const startLine = state.doc.lineAt(Math.min(range.from, state.doc.length));
    const inclusiveEnd = range.to > range.from ? range.to - 1 : range.to;
    const endLine = state.doc.lineAt(Math.max(range.from, Math.min(inclusiveEnd, state.doc.length)));
    for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      const classes = [invisible ? 'meo-md-html-invisible-source' : 'meo-md-html-source-range'];
      if (!invisible && lineNumber === startLine.number) classes.push('meo-md-html-source-line', 'meo-md-html-source-range-start');
      if (!invisible && lineNumber === endLine.number) classes.push('meo-md-html-source-range-end');
      if (invalid) classes.push('meo-md-html-source-invalid');
      ranges.push(Decoration.line({ class: classes.join(' ') }).range(line.from));
    }
    if (invisible && range.to > range.from) ranges.push(Decoration.mark({ class: 'meo-md-html-invisible-source-text' }).range(range.from, range.to));
  };
  let editingBlockFound = false;
  const previous = blocks.length && previousDecorations && changes
    ? previousDecorations.map(changes)
    : previousDecorations;
  for (const block of blocks) {
    const isEditing = editingRange && editingRange.from === block.from;
    if (isEditing) {
      editingBlockFound = true;
      addSourceRange(editingRange);
      if (block.visible) {
        const followingLine = block.endLine < state.doc.lines ? state.doc.line(block.endLine + 1) : null;
        ranges.push(Decoration.widget({ widget: new HtmlBlockWidget(block, true), block: true, side: followingLine ? -1 : 1 })
          .range(followingLine?.from ?? state.doc.line(block.endLine).to));
      }
      continue;
    }
    if (!block.visible) {
      addSourceRange(block, false, true);
      continue;
    }
    const widget = new HtmlBlockWidget(block);
    previous?.between(block.from, block.to, (_from, _to, decoration) => {
      if (decoration.spec.widget instanceof HtmlBlockWidget) {
        widget.seedHeight(decoration.spec.widget);
      }
    });
    ranges.push(Decoration.replace({
      block: true,
      widget
    }).range(block.from, block.to));
  }
  if (editingRange && !editingBlockFound) {
    addSourceRange(editingRange, true);
    const source = state.doc.sliceString(editingRange.from, editingRange.to);
    const rendered = renderHtmlMarkdown(source);
    if (isSupportedHtmlWithComments(rendered) && htmlHasVisibleContent(rendered)) {
      const endLine = state.doc.lineAt(Math.max(editingRange.from, editingRange.to - 1));
      const followingLine = endLine.number < state.doc.lines ? state.doc.line(endLine.number + 1) : null;
      ranges.push(Decoration.widget({ widget: new HtmlBlockWidget({ ...editingRange, source,
        startLine: state.doc.lineAt(editingRange.from).number, endLine: endLine.number,
        detailsCollapsed: null, visible: true }, true), block: true, side: followingLine ? -1 : 1 })
        .range(followingLine?.from ?? endLine.to));
    }
  }
  const warningLines = new Set<number>();
  resolvedSyntaxTree(state).iterate({
    enter(node: SyntaxNodeRef) {
      if (node.name !== 'HTMLBlock' && node.name !== 'HTMLTag') return;
      const source = state.doc.sliceString(node.from, node.to);
      if (isSupportedHtmlWithComments(source)) return;
      const line = state.doc.lineAt(node.from);
      if (warningLines.has(line.number)) return;
      warningLines.add(line.number);
      ranges.push(Decoration.widget({
        widget: new HtmlWarningWidget(),
        side: -1
      }).range(line.to));
    }
  });
  addInlineHtmlDecorations(ranges, state, activeLines, blocks, inlineRanges);
  return blocks;
}

const htmlEscapeKeymap = keymap.of([{
  key: 'Escape',
  run(view) {
    const range = getHtmlEditingRange(view.state);
    if (!range) return false;
    preserveHtmlPosition(view, () => view.dispatch({ selection: { anchor: range.to }, effects: setHtmlEditingRangeEffect.of(null) }));
    return true;
  }
}]);

function revealHtmlSourceForInput(view: EditorView, target: EventTarget | null): void {
  if (target !== view.contentDOM || getHtmlEditingRange(view.state)) return;
  const selection = view.state.selection.main;
  const block = collectRenderableHtmlBlocks(view.state).find((block) => (
    selection.from >= block.from && selection.to <= block.to
  ));
  if (block) enterHtmlSource(view, block);
}

// Reveal before both native input and CodeMirror editing commands. A rendered
// replacement cannot express the saved DOM caret and would redirect native typing.
const htmlSourceInputHandlers = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    const selection = view.state.selection.main;
    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && selection.empty
      && event.key.startsWith('Arrow') && !getHtmlEditingRange(view.state)) {
      const line = view.state.doc.lineAt(selection.head);
      const block = collectRenderableHtmlBlocks(view.state).find(block => block.visible && (
        event.key === 'ArrowDown' && block.startLine === line.number + 1
        || event.key === 'ArrowUp' && block.endLine === line.number - 1
        || event.key === 'ArrowLeft' && block.to === selection.head
        || event.key === 'ArrowRight' && block.from === selection.head + 1
      ));
      if (block) {
        view.dispatch({ selection: { anchor: ['ArrowUp', 'ArrowLeft'].includes(event.key) ? block.to - 1 : block.from },
          effects: setHtmlEditingRangeEffect.of({ from: block.from, to: block.to }), scrollIntoView: true });
        return true;
      }
    }
    const shortcut = (event.ctrlKey || event.metaKey) && !event.altKey && /^[vx]$/i.test(event.key);
    const editingKey = ['Enter', 'Backspace', 'Delete'].includes(event.key) || (
      !event.ctrlKey && !event.metaKey && !event.altKey &&
      (event.key.length === 1 || event.key === 'Process')
    );
    if (shortcut || editingKey) revealHtmlSourceForInput(view, event.target);
    return false;
  },
  beforeinput(event, view) {
    if (/^(insert|delete)/.test(event.inputType)) revealHtmlSourceForInput(view, event.target);
    return false;
  },
  compositionstart(event, view) {
    revealHtmlSourceForInput(view, event.target);
    return false;
  },
  paste(event, view) {
    revealHtmlSourceForInput(view, event.target);
    return false;
  },
  cut(event, view) {
    revealHtmlSourceForInput(view, event.target);
    return false;
  }
}));

export function htmlContentExtensions() {
  return [htmlEditingRangeField, htmlEscapeKeymap, htmlBlockLineNumberMarker, htmlSourceInputHandlers];
}
