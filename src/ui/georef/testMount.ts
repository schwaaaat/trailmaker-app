import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BasemapPane } from './BasemapPane';
import { OverlayPreview } from './OverlayPreview';
import type { BasemapHandle, BasemapPaneProps, OverlayPreviewProps } from './types';

void React;

export interface MountedComponent {
  readonly root: Root;
  readonly unmount: () => void;
}

/**
 * Mount helper for e2e tests and harnesses.
 */
export function mountBasemapPane(
  container: HTMLElement,
  props?: BasemapPaneProps,
): MountedComponent {
  const root = createRoot(container);
  root.render(React.createElement(BasemapPane, props));
  return {
    root,
    unmount: () => root.unmount(),
  };
}

export interface MountOverlayPreviewOptions extends OverlayPreviewProps {
  /** Optional handle ref to expose imperative BasemapHandle. */
  readonly handleRef?: React.Ref<BasemapHandle>;
}

export function mountOverlayPreview(
  container: HTMLElement,
  props?: MountOverlayPreviewOptions,
): MountedComponent {
  const root = createRoot(container);
  const handleRef = props?.handleRef;
  root.render(React.createElement(OverlayPreview, { ...props, ref: handleRef }));
  return {
    root,
    unmount: () => root.unmount(),
  };
}
