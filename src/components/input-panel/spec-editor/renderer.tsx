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

// ─── Color preview SVG builders ──────────────────────────────────

/**
 * Shared SVG builder for "Normal vs X" color previews.
 *
 * Both CVD simulation and grayscale previews follow the same layout:
 * two rows of color swatches (or gradients) with labels.
 * This function extracts the common rendering logic.
 *
 * @param originalColors  - The original CSS colors from the scale.
 * @param transformedColors - The simulated/grayscale CSS colors.
 * @param transformLabel  - Label for the second row (e.g. "Protanopia", "Grayscale").
 * @param isContinuous    - Whether to render a smooth gradient or discrete swatches.
 * @returns An encoded SVG data URI string for embedding in Markdown.
 */
function buildColorPreviewSvg(
  originalColors: string[],
  transformedColors: string[],
  transformLabel: string,
  isContinuous: boolean,
): string {
  // Layout constants
  const labelW = 90;
  const barH = 20;
  const rowGap = 6;
  const paddingX = 8;
  const paddingY = 6;
  const barW = isContinuous ? 260 : originalColors.length * 26 - 2;

  const svgW = labelW + barW + paddingX * 2;
  const svgH = 2 * barH + rowGap + paddingY * 2;
  const normalY = paddingY;
  const simY = paddingY + barH + rowGap;
  const textStyle = 'font-family:system-ui,sans-serif;font-size:11px;fill:#333';
  const barX = labelW + paddingX;

  let defs = '';
  let normalBar = '';
  let simBar = '';

  if (isContinuous) {
    // Build gradient stops from the color arrays
    const gradientStops = (colors: string[], id: string): string => {
      const stops = colors
        .map((color, i) => {
          const offset = colors.length === 1 ? 50 : Math.round((i / (colors.length - 1)) * 100);
          return `<stop offset="${offset}%" stop-color="${color}"/>`;
        })
        .join('');
      return `<linearGradient id="${id}">${stops}</linearGradient>`;
    };

    defs = [
      '<defs>',
      gradientStops(originalColors, 'origGrad'),
      gradientStops(transformedColors, 'simGrad'),
      '</defs>',
    ].join('');

    normalBar = `<rect x="${barX}" y="${normalY}" width="${barW}" height="${barH}" fill="url(#origGrad)" rx="2"/>`;
    simBar = `<rect x="${barX}" y="${simY}" width="${barW}" height="${barH}" fill="url(#simGrad)" rx="2"/>`;
  } else {
    // Discrete swatches for categorical scales
    const swatchW = 24;
    const gap = 2;

    const swatchRow = (colors: string[], y: number): string =>
      colors
        .map((color, i) => {
          const x = barX + i * (swatchW + gap);
          return `<rect x="${x}" y="${y}" width="${swatchW}" height="${barH}" fill="${color}" rx="2"/>`;
        })
        .join('');

    normalBar = swatchRow(originalColors, normalY);
    simBar = swatchRow(transformedColors, simY);
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">`,
    `<rect width="${svgW}" height="${svgH}" fill="#fff" rx="4"/>`,
    defs,
    `<text x="${paddingX}" y="${normalY + 14}" style="${textStyle}">Normal</text>`,
    normalBar,
    `<text x="${paddingX}" y="${simY + 14}" style="${textStyle}">${transformLabel}</text>`,
    simBar,
    `</svg>`,
  ].join('');

  return `![Color preview](data:image/svg+xml,${encodeURIComponent(svg)})`;
}

/**
 * Build an inline SVG showing "Normal" and "Simulated (CVD type)" color previews.
 *
 * Returns an encoded data URI string for embedding in Markdown, or
 * an empty string if the issue has no CVD preview data.
 */
function buildCvdPreviewSvg(issue: AccessibilityIssue): string {
  const {originalColors, simulatedColors, cvdType, scaleType} = issue.evidence ?? {};
  if (!Array.isArray(originalColors) || !Array.isArray(simulatedColors) || originalColors.length === 0) {
    return '';
  }

  const cvdLabels: Record<string, string> = {
    protanopia: 'Protanopia',
    deuteranopia: 'Deuteranopia',
    tritanopia: 'Tritanopia',
  };
  const simLabel = cvdLabels[cvdType as string] ?? 'Simulated';
  const isContinuous = scaleType === 'sequential';

  return buildColorPreviewSvg(originalColors as string[], simulatedColors as string[], simLabel, isContinuous);
}

/**
 * Build an inline SVG showing "Normal" and "Grayscale" color previews.
 *
 * Returns an encoded data URI string for embedding in Markdown, or
 * an empty string if the issue has no grayscale preview data.
 */
function buildGrayscalePreviewSvg(issue: AccessibilityIssue): string {
  const {originalColors, grayscaleColors, scaleType} = issue.evidence ?? {};
  if (!Array.isArray(originalColors) || !Array.isArray(grayscaleColors) || originalColors.length === 0) {
    return '';
  }

  const isContinuous = scaleType === 'sequential';

  return buildColorPreviewSvg(originalColors as string[], grayscaleColors as string[], 'Grayscale', isContinuous);
}

// ─── Issue → decoration / marker conversion ─────────────────────

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

    // Build the hover content — add color preview when available
    const cvdPreview = buildCvdPreviewSvg(issue);
    const grayscalePreview = buildGrayscalePreviewSvg(issue);

    const hoverParts = [
      `**Accessibility** (${issue.severity})`,
      '',
      issue.message,
      '',
      `Suggestion: ${issue.suggestion}`,
    ];
    if (cvdPreview) {
      hoverParts.push('', cvdPreview);
    }
    if (grayscalePreview) {
      hoverParts.push('', grayscalePreview);
    }

    decorations.push({
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
      options: {
        className: 'a11yRangeDecoration',
        inlineClassName: 'a11yInlineDecoration',
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
    markers.push({
      startLineNumber: start.lineNumber,
      // Place zero-width marker at column 1 (line start / whitespace)
      // so it feeds the problems panel but never triggers a hover
      // tooltip that would overlap with our decoration hover.
      startColumn: 1,
      endLineNumber: start.lineNumber,
      endColumn: 1,
      severity: monaco.MarkerSeverity.Warning,
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
  setEditorFocus: (focus: string) => void;
  setEditorReference: (reference: any) => void;
  updateEditorString: (editorString: string) => void;
  updateVegaLiteSpec: (spec: string, config?: string) => void;
  updateVegaSpec: (spec: string, config?: string) => void;
}> = (props) => {
  const {state} = useAppContext();
  const {mode, editorString, decorations, manualParse, parse, sidePaneItem, configEditorString, accessibilityIssues} =
    state;

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const [currentDecorationIds, setCurrentDecorationIds] = useState<string[]>([]);

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