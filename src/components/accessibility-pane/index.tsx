import * as React from 'react';
import {useAppContext} from '../../context/app-context.js';
import Renderer from './renderer.js';

export default function AccessibilityPane() {
  const {state} = useAppContext();
  const {accessibilityIssues} = state;

  return <Renderer issues={accessibilityIssues ?? []} />;
}