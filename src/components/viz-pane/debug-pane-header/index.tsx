import * as React from 'react';
import {useCallback, useEffect, useRef} from 'react';
import {ChevronDown, ChevronUp} from 'react-feather';
import {useAppContext} from '../../../context/app-context.js';
import {NAVBAR} from '../../../constants/consts.js';

const DebugPaneHeader: React.FC = () => {
  const {state, setState} = useAppContext();
  const effectRan = useRef(false);

  const {debugPane, error, errors, logs, navItem, warns, accessibilityIssues} = state;

  const showLogs = useCallback((show: boolean) => setState((s) => ({...s, logs: show})), [setState]);

  const toggleDebugPane = useCallback(() => setState((s) => ({...s, debugPane: !s.debugPane})), [setState]);

  const toggleNavbar = useCallback((item: string) => setState((s) => ({...s, navItem: item})), [setState]);

  useEffect(() => {
    if (!effectRan.current && (logs || navItem === NAVBAR.Logs)) {
      effectRan.current = true;
      showLogs(true);
    }
  }, [logs, navItem, showLogs]);

  const handleLogsClick = useCallback(
    (e: React.MouseEvent) => {
      if (debugPane) {
        e.stopPropagation();
      }
      showLogs(true);
      toggleNavbar(NAVBAR.Logs);
    },
    [debugPane, showLogs, toggleNavbar],
  );

  const handleDataViewerClick = useCallback(
    (e: React.MouseEvent) => {
      if (debugPane) {
        e.stopPropagation();
      }
      showLogs(false);
      toggleNavbar(NAVBAR.DataViewer);
    },
    [debugPane, showLogs, toggleNavbar],
  );

  const handleSignalViewerClick = useCallback(
    (e: React.MouseEvent) => {
      if (debugPane) {
        e.stopPropagation();
      }
      showLogs(false);
      toggleNavbar(NAVBAR.SignalViewer);
    },
    [debugPane, showLogs, toggleNavbar],
  );

  const handleDataflowViewerClick = useCallback(
    (e: React.MouseEvent) => {
      if (debugPane) {
        e.stopPropagation();
      }
      showLogs(false);
      toggleNavbar(NAVBAR.DataflowViewer);
    },
    [debugPane, showLogs, toggleNavbar],
  );

  const handleAccessibilityClick = useCallback(
    (e: React.MouseEvent) => {
      if (debugPane) {
        e.stopPropagation();
      }
      showLogs(false);
      toggleNavbar(NAVBAR.Accessibility);
    },
    [debugPane, showLogs, toggleNavbar],
  );

  // The Accessibility tab shows a `(N)` counter with the total issue
  // count. We deliberately do NOT auto-open the debug pane on issues —
  // unlike errors, most charts have at least one issue (e.g. default
  // font-size info), which would be too aggressive a UX.
  const accessibilityCount = accessibilityIssues?.length ?? 0;

  return (
    <div className="pane-header" onClick={toggleDebugPane}>
      <ul className="tabs-nav">
        <li className={error || (logs && navItem === NAVBAR.Logs) ? 'active-tab' : undefined} onClick={handleLogsClick}>
          <span className="logs-text">Logs</span>
          {error ? (
            <span className="error">(Error)</span>
          ) : errors.length > 0 ? (
            <span className="error">({errors.length})</span>
          ) : warns.length > 0 ? (
            <span className="warnings-count">({warns.length})</span>
          ) : (
            ''
          )}
        </li>
        {error === null && (
          <li className={navItem === NAVBAR.DataViewer ? 'active-tab' : undefined} onClick={handleDataViewerClick}>
            Data Viewer
          </li>
        )}
        {error === null && (
          <li className={navItem === NAVBAR.SignalViewer ? 'active-tab' : undefined} onClick={handleSignalViewerClick}>
            Signal Viewer
          </li>
        )}
        {error === null && (
          <li
            className={navItem === NAVBAR.DataflowViewer ? 'active-tab' : undefined}
            onClick={handleDataflowViewerClick}
          >
            Dataflow Viewer
          </li>
        )}
        {error === null && (
          <li
            className={navItem === NAVBAR.Accessibility ? 'active-tab' : undefined}
            onClick={handleAccessibilityClick}
          >
            Accessibility
            {accessibilityCount > 0 && ` (${accessibilityCount})`}
          </li>
        )}
      </ul>
      {debugPane ? <ChevronDown /> : <ChevronUp />}
    </div>
  );
};

export default DebugPaneHeader;