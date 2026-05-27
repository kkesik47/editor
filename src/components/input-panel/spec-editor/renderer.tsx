import stringify from 'json-stringify-pretty-compact';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import * as React from 'react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useAppContext} from '../../../context/app-context.js';
import './index.css';
import {EDITOR_FOCUS, KEYCODES, Mode, SCHEMA, SIDEPANE} from '../../../constants/index.js';
import {useLocation, useNavigate, useParams} from 'react-router-dom';
import {findNodeAtLocation, parse as parseJSONC, parseTree} from 'jsonc-parser';
import LZString from 'lz-string';
import ResizeObserver from 'rc-resize-observer';
import {debounce} from 'vega';
import parser from 'vega-schema-url-parser';
import type {AccessibilityIssue} from '../../../features/accessibility/types.js';
import {resolveIssueReferences} from '../../../features/accessibility/resolveIssueReferences.js';

type MonacoModule = typeof import('monaco-editor');

function jsonPointerToPath(pointer: string): (string | number)[] {
  if (!pointer || pointer === '/') {
    return [];
  }
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((token) => {
      const asNumber = Number(token);
      return Number.isInteger(asNumber) && `${asNumber}` === token ? asNumber : token;
    });
}

// ─── Decoration style helpers ────────────────────────────────────

/**
 * Check whether an issue is a WCAG AAA suggestion (as opposed to
 * a Level A / AA warning). AAA issues get a distinct blue-gray
 * underline to visually separate "must fix" from "nice to have".
 */
function isAAASuggestion(issue: AccessibilityIssue): boolean {
  return issue.evidence?.wcagLevel === 'AAA';
}

// ─── Issue → decoration / marker conversion ─────────────────────

/**
 * Append APA-style in-text citations to a message inside the final
 * sentence, then italicize the whole parenthetical via Markdown.
 *
 * The parens are included inside the italics so the citation cluster
 * reads as one visually-soft block rather than as part of the prose:
 *
 *     "...low color vision _(Brettel et al., 1997; Birch, 2012)_."
 *
 * When the message ends with a period, citations are inserted BEFORE
 * the period so the sentence stays grammatical. When it doesn't end
 * with a period, citations are simply appended.
 *
 * Returns the original message unchanged if there are no references.
 *
 * NB: this mirrors `appendCitations` in the accessibility pane, but
 * adds Markdown italic markers because Monaco hovers render Markdown
 * while the pane renders plain React text. Kept as separate functions
 * because the wrapping syntax differs — sharing would require either
 * a "render mode" parameter or post-hoc formatting, both of which
 * obscure intent at the call sites.
 */
function appendCitationsMarkdown(issue: AccessibilityIssue): string {
  const references = resolveIssueReferences(issue);
  if (references.length === 0) return issue.message;

  const citations = references.map((r) => r.shortCitation).join('; ');
  const italicized = `_(${citations})_`;
  const trimmed = issue.message.trimEnd();

  if (trimmed.endsWith('.')) {
    return `${trimmed.slice(0, -1)} ${italicized}.`;
  }
  return `${trimmed} ${italicized}`;
}

/**
 * Convert accessibility issues into Monaco editor decorations.
 *
 * Creates wavy underline decorations with hover tooltips for each
 * issue. The jsonPointer on the issue determines which JSON node
 * gets underlined:
 *   - Inline values (e.g. "labelFontSize": 9) → underlines just the value
 *   - Config values → underlines the config property value
 *   - Default values → underlines the specific channel (e.g. /encoding/x)
 *
 * AAA-level issues (suggestions) get a distinct blue-gray underline
 * to visually separate them from mandatory A/AA warnings (yellow).
 *
 * The hover tooltip shows the severity header, the rule's plain-
 * language message with inline italicized APA citations, and a
 * pointer to the Accessibility tab for full details (suggestion text,
 * color previews, grayscale previews, clickable DOI links, etc.).
 * Keeping the tooltip brief avoids clutter while authors are editing,
 * and lets the dedicated pane host the richer content where there's
 * room for it.
 */
function toIssueDecorations(
  issues: AccessibilityIssue[],
  editor: Monaco.editor.IStandaloneCodeEditor | null,
): Monaco.editor.IModelDeltaDecoration[] {
  const model = editor?.getModel();
  if (!model) {
    return [];
  }

  const tree = parseTree(model.getValue());
  if (!tree) {
    return [];
  }

  const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
  for (const issue of issues) {
    if (issue.jsonPointer == null) {
      continue;
    }

    const path = jsonPointerToPath(issue.jsonPointer);
    const node = findNodeAtLocation(tree, path);
    if (!node) {
      continue;
    }

    const start = model.getPositionAt(node.offset);
    const end = model.getPositionAt(node.offset + node.length);

    // AAA issues are framed as suggestions, not problems
    const isAAA = isAAASuggestion(issue);
    const header = isAAA ? `**Accessibility suggestion** (WCAG AAA)` : `**Accessibility** (${issue.severity})`;

    // Brief tooltip: header + message-with-italic-citations + footer.
    // Full details (suggestion, previews, clickable references) live
    // in the Accessibility tab.
    const hoverParts = [header, '', appendCitationsMarkdown(issue), '', 'See the Accessibility tab for details.'];

    // Pick decoration class based on WCAG level
    const inlineClass = isAAA ? 'a11ySuggestionInlineDecoration' : 'a11yInlineDecoration';
    const rangeClass = isAAA ? 'a11ySuggestionRangeDecoration' : 'a11yRangeDecoration';

    decorations.push({
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
      options: {
        className: rangeClass,
        inlineClassName: inlineClass,
        stickiness: 1,
        hoverMessage: {
          value: hoverParts.join('\n'),
          supportHtml: true,
          isTrusted: true,
        },
      },
    });
  }

  return decorations;
}

/**
 * Convert accessibility issues into Monaco marker data for the
 * problems panel.
 *
 * Markers use zero-width ranges (startColumn === endColumn) placed
 * at line start so they feed the problems panel without generating
 * a hover tooltip that would overlap with the decoration hover.
 */
function toIssueMarkers(
  issues: AccessibilityIssue[],
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  monaco: MonacoModule | null,
): Monaco.editor.IMarkerData[] {
  const model = editor?.getModel();
  if (!model || !monaco) {
    return [];
  }

  const tree = parseTree(model.getValue());
  if (!tree) {
    return [];
  }

  // Map issue severity to Monaco marker severity
  const severityMap: Record<string, Monaco.MarkerSeverity> = {
    error: monaco.MarkerSeverity.Error,
    warning: monaco.MarkerSeverity.Warning,
    info: monaco.MarkerSeverity.Info,
  };

  const markers: Monaco.editor.IMarkerData[] = [];
  for (const issue of issues) {
    if (issue.jsonPointer == null) {
      continue;
    }

    const path = jsonPointerToPath(issue.jsonPointer);
    const node = findNodeAtLocation(tree, path);
    if (!node) {
      continue;
    }

    const start = model.getPositionAt(node.offset);
    const markerSeverity = severityMap[issue.severity] ?? monaco.MarkerSeverity.Warning;

    markers.push({
      startLineNumber: start.lineNumber,
      // Place zero-width marker at column 1 (line start / whitespace)
      // so it feeds the problems panel but never triggers a hover
      // tooltip that would overlap with our decoration hover.
      startColumn: 1,
      endLineNumber: start.lineNumber,
      endColumn: 1,
      severity: markerSeverity,
      source: issue.ruleId,
      message: `${issue.message}\nSuggestion: ${issue.suggestion}`,
    });
  }
  return markers;
}

// ─── Editor component ────────────────────────────────────────────

const EditorWithNavigation: React.FC<{
  clearConfig: () => void;
  extractConfigSpec: () => void;
  logError: (error: Error) => void;
  mergeConfigSpec: () => void;
  parseSpec: (force: boolean) => void;
  setConfig: (config: string) => void;
  setDecorations: (decorations: any[]) => void;
  setEditorFocus: (focus: any) => void;
  setEditorReference: (reference: any) => void;
  updateEditorString: (editorString: string) => void;
  updateVegaLiteSpec: (spec: string, config?: string) => void;
  updateVegaSpec: (spec: string, config?: string) => void;
}> = (props) => {
  const {state} = useAppContext();
  const {
    mode,
    editorString,
    decorations,
    manualParse,
    parse,
    sidePaneItem,
    configEditorString,
    accessibilityIssues,
    hoveredIssueKeys,
  } = state;

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const [currentDecorationIds, setCurrentDecorationIds] = useState<string[]>([]);
  // Independent decorations collection for the heatmap hover highlight.
  // Using a collection (rather than a second deltaDecorations id list)
  // keeps this fully isolated from the issue-underline decorations, so
  // the two never clear each other's ids. Created lazily on first use.
  const hoverCollectionRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const {compressed} = useParams<{compressed?: string}>();

  const updateSpec = useCallback(
    (spec: string, config: string = undefined) => {
      let parsedMode = mode;
      try {
        const schema = parseJSONC(spec).$schema;
        if (schema) {
          const parsedSchema = parser(schema);
          if (parsedSchema.library === 'vega-lite') {
            parsedMode = Mode.VegaLite;
          } else if (parsedSchema.library === 'vega') {
            parsedMode = Mode.Vega;
          }
        }
      } catch (e) {
        // spec is not a valid JSON
      }

      if (parsedMode === Mode.Vega) {
        props.updateVegaSpec(spec, config);
      } else {
        props.updateVegaLiteSpec(spec, config);
      }
    },
    [mode, props.updateVegaSpec, props.updateVegaLiteSpec],
  );

  const debouncedUpdateSpec = useCallback(debounce(1200, updateSpec), [updateSpec]);

  useEffect(() => {
    if (compressed) {
      let spec: string = LZString.decompressFromEncodedURIComponent(compressed);
      if (spec) {
        try {
          const newlines = (spec.match(/\n/g) || '').length + 1;
          if (newlines <= 1) {
            spec = stringify(parseJSONC(spec));
          }
          if (spec !== editorString) {
            updateSpec(spec);
          }
        } catch (e) {
          props.logError(e as Error);
        }
      } else {
        props.logError(new Error(`Failed to decompress URL. Expected a specification, but received ${spec}`));
      }
    }
  }, [compressed, editorString, props.logError, updateSpec]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (manualParse) {
        if ((e.keyCode === KEYCODES.B || e.keyCode === KEYCODES.S) && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          props.parseSpec(true);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [manualParse, props.parseSpec]);

  useEffect(() => {
    if (editorRef.current && parse) {
      editorRef.current.focus();
      editorRef.current.layout();
      updateSpec(editorString, configEditorString);
      props.parseSpec(false);
    }
  }, [parse, editorString, configEditorString, updateSpec, props]);

  useEffect(() => {
    if (sidePaneItem === SIDEPANE.Editor && editorRef.current) {
      editorRef.current.focus();
      editorRef.current.layout();
    }
  }, [sidePaneItem]);

  const handleEditorDidMount = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor, monaco: MonacoModule) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      props.setEditorReference(editor);

      const addVegaSchemaURL = () => {
        try {
          let spec = parseJSONC(editor.getValue());
          if (spec.$schema === undefined) {
            spec = {
              $schema: SCHEMA[Mode.Vega],
              ...spec,
            };
            if (confirm('Adding schema URL will format the specification too.')) {
              props.updateVegaSpec(stringify(spec));
            }
          }
        } catch (e) {
          props.logError(e as Error);
        }
      };

      const addVegaLiteSchemaURL = () => {
        try {
          let spec = parseJSONC(editor.getValue());
          if (spec.$schema === undefined) {
            spec = {
              $schema: SCHEMA[Mode.VegaLite],
              ...spec,
            };
            if (confirm('Adding schema URL will format the specification too.')) {
              props.updateVegaLiteSpec(stringify(spec));
            }
          }
        } catch (e) {
          props.logError(e as Error);
        }
      };

      const handleMergeConfig = () => {
        if (confirm('The spec will be formatted on merge.')) {
          if (location.pathname !== '/edited') {
            navigate('/edited');
          }
          props.mergeConfigSpec();
        }
      };

      const handleExtractConfig = () => {
        if (confirm('The spec and config will be formatted.')) {
          props.extractConfigSpec();
        }
      };

      editor.onDidFocusEditorText(() => {
        props.setEditorFocus(EDITOR_FOCUS.SpecEditor);
        props.setEditorReference(editor);
      });

      editor.addAction({
        contextMenuGroupId: 'vega',
        contextMenuOrder: 0,
        id: 'ADD_VEGA_SCHEMA',
        label: 'Add Vega schema URL',
        run: addVegaSchemaURL,
      });

      editor.addAction({
        contextMenuGroupId: 'vega',
        contextMenuOrder: 1,
        id: 'ADD_VEGA_LITE_SCHEMA',
        label: 'Add Vega-Lite schema URL',
        run: addVegaLiteSchemaURL,
      });

      editor.addAction({
        contextMenuGroupId: 'vega',
        contextMenuOrder: 2,
        id: 'CLEAR_EDITOR',
        label: 'Clear Spec',
        run: () => {
          if (mode === Mode.Vega) {
            navigate('/custom/vega');
          } else {
            navigate('/custom/vega-lite');
          }
        },
      });

      editor.addAction({
        contextMenuGroupId: 'vega',
        contextMenuOrder: 3,
        id: 'MERGE_CONFIG',
        label: 'Merge Config Into Spec',
        run: handleMergeConfig,
      });

      editor.addAction({
        contextMenuGroupId: 'vega',
        contextMenuOrder: 4,
        id: 'EXTRACT_CONFIG',
        label: 'Extract Config From Spec',
        run: handleExtractConfig,
      });
    },
    [props, manualParse, debouncedUpdateSpec, location.pathname, navigate, mode],
  );

  const handleEditorChange = useCallback(
    (value: string) => {
      if (manualParse) {
        props.updateEditorString(value);
      } else {
        debouncedUpdateSpec(value);
      }
      if (location.pathname.indexOf('/edited') === -1) {
        navigate('/edited');
      }
    },
    [manualParse, props.updateEditorString, debouncedUpdateSpec, location.pathname, navigate],
  );

  const mergedDecorations = useMemo(() => {
    const issueDecorations = toIssueDecorations(accessibilityIssues || [], editorRef.current);
    return [...(Array.isArray(decorations) ? decorations : []), ...issueDecorations];
  }, [accessibilityIssues, decorations, editorString]);

  useEffect(() => {
    if (editorRef.current) {
      const newDecorationIds = editorRef.current.deltaDecorations(currentDecorationIds, mergedDecorations);
      setCurrentDecorationIds(newDecorationIds);
    }
  }, [mergedDecorations]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || !monacoRef.current) {
      return;
    }

    const markers = toIssueMarkers(accessibilityIssues || [], editorRef.current, monacoRef.current);
    monacoRef.current.editor.setModelMarkers(model, 'vega-editor-a11y', markers);
  }, [accessibilityIssues, editorString]);

  // Highlight the source line(s) for whichever issues are hovered on
  // the chart heatmap. `hoveredIssueKeys` is set by the heatmap overlay
  // (a cluster can represent several issues) and cleared to [] on
  // mouse-leave. We reuse the same jsonPointer → Monaco-position mapping
  // as the issue decorations, once per issue in the cluster.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) {
      return;
    }

    // Lazily create the collection on first run, then reuse it.
    if (!hoverCollectionRef.current) {
      hoverCollectionRef.current = editor.createDecorationsCollection();
    }
    const collection = hoverCollectionRef.current;

    const hoveredKeys = hoveredIssueKeys ?? [];

    // Nothing hovered → clear the highlight (leaves issue underlines
    // untouched, since they live in a different decoration owner).
    if (hoveredKeys.length === 0) {
      collection.clear();
      return;
    }

    // The heatmap builds each key as `${ruleId}|${jsonPointer}|${index}`,
    // matching the accessibility pane. Recompute per issue, keep those in
    // the hovered set, and map each to a line range.
    const issues = accessibilityIssues ?? [];
    const tree = parseTree(model.getValue());

    const decorations = issues
      .map((issue, index) => ({issue, key: `${issue.ruleId}|${issue.jsonPointer}|${index}`}))
      .filter(({issue, key}) => hoveredKeys.includes(key) && issue.jsonPointer != null)
      .map(({issue}) => {
        const node = tree ? findNodeAtLocation(tree, jsonPointerToPath(issue.jsonPointer)) : undefined;
        if (!node) return null;
        const start = model.getPositionAt(node.offset);
        const end = model.getPositionAt(node.offset + node.length);
        return {
          range: {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          },
          options: {
            // Highlight the whole line(s) plus the exact span, so the
            // author's eye is drawn to the right place even for a value
            // deep in a line.
            isWholeLine: true,
            className: 'a11yHoverLineHighlight',
            inlineClassName: 'a11yHoverInlineHighlight',
          },
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);

    if (decorations.length === 0) {
      collection.clear();
    } else {
      collection.set(decorations);
    }
  }, [hoveredIssueKeys, accessibilityIssues]);

  return (
    <ResizeObserver
      onResize={({width, height}) => {
        editorRef.current?.layout({width, height});
      }}
    >
      <div style={{width: '100%', height: '100%', display: 'flex', flexDirection: 'column'}}>
        <div style={{flexGrow: 1, position: 'relative'}}>
          <Editor
            height="100%"
            language="json"
            value={editorString}
            onMount={handleEditorDidMount}
            onChange={handleEditorChange}
            options={{
              cursorBlinking: 'smooth',
              folding: true,
              lineNumbersMinChars: 4,
              minimap: {enabled: false},
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              quickSuggestions: true,
              stickyScroll: {
                enabled: false,
              },
            }}
          />
        </div>
      </div>
    </ResizeObserver>
  );
};

export default EditorWithNavigation;